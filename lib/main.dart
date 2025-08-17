import 'dart:convert';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:csv/csv.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart'; // kIsWeb
import 'package:flutter/material.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() => runApp(const StatsApp());

class StatsApp extends StatelessWidget {
  const StatsApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bingo 歷史熱度',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),
      home: const StatsHome(),
      debugShowCheckedModeBanner: false,
    );
  }
}

class StatsHome extends StatefulWidget {
  const StatsHome({super.key});
  @override
  State<StatsHome> createState() => _StatsHomeState();
}

class _StatsHomeState extends State<StatsHome> {
  // ---- 常數與儲存鍵 ----
  static const int N = 80; // 1..80
  static const int K = 20; // 每期 20 顆
  static const String storeKeyV2 = 'bingo_draws_v2'; // [{nums:[...], super:58}, ...]
  static const String storeKeyV1 = 'bingo_draws_v1'; // 舊版：[[...], [...]]

  /// draws[0] = 最新一期；每筆：{"nums": List<int>(20,升冪), "super": int?}
  List<Map<String, dynamic>> draws = [];
  int sampleSize = 100; // -1 表示全部

  @override
  void initState() {
    super.initState();
    _load();
  }

  // ---- 儲存層 ----
  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    String? raw = sp.getString(storeKeyV2);
    if (raw != null && raw.isNotEmpty) {
      try {
        final data = jsonDecode(raw) as List<dynamic>;
        draws = data.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      } catch (_) {}
    } else {
      // 舊版升級
      final old = sp.getString(storeKeyV1);
      if (old != null && old.isNotEmpty) {
        try {
          final data = jsonDecode(old) as List<dynamic>;
          final list =
              data.map((e) => (e as List).map((x) => x as int).toList()).toList();
          draws = [
            for (final nums in list) {"nums": (nums..sort()), "super": null}
          ];
          await _save();
        } catch (_) {}
      }
    }
    if (mounted) setState(() {});
  }

  Future<void> _save() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(storeKeyV2, jsonEncode(draws));
  }

  // ---- 工具 ----
  double safeRatio(int count, int total) {
    if (total <= 0) return 0.0;
    final v = count / total;
    return v.isFinite ? v.clamp(0.0, 1.0) : 0.0;
  }

  // ---- 資料處理 ----
  List<Map<String, dynamic>> _recentDraws() {
    if (draws.isEmpty) return const [];
    if (sampleSize <= 0 || sampleSize > draws.length) return draws;
    return draws.take(sampleSize).toList();
  }

  Map<int, int> _countFreq() {
    final freq = <int, int>{};
    for (final d in _recentDraws()) {
      for (final n in (d['nums'] as List).cast<int>()) {
        freq[n] = (freq[n] ?? 0) + 1;
      }
    }
    return freq;
  }

  Map<int, int> _countSuperFreq() {
    final freq = <int, int>{};
    for (final d in _recentDraws()) {
      final s = d['super'];
      if (s is int && s >= 1 && s <= 80) {
        freq[s] = (freq[s] ?? 0) + 1;
      }
    }
    return freq;
  }

  void _addDraw(List<int> nums, {int? superNum}) {
    final key = nums.join(',');
    final exists =
        draws.any((e) => (e['nums'] as List).cast<int>().join(',') == key);
    if (exists) return;
    setState(() {
      draws.insert(0, {"nums": (nums..sort()), "super": superNum});
    });
    _save();
  }

  // ---- 匯入 CSV（平台分流）----
  Future<void> _importCsv() async {
    try {
      final res = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['csv'],
        withData: true,
        withReadStream: true,
      );
      if (res == null || res.files.isEmpty) return;
      final f = res.files.first;

      // 讀 bytes
      Uint8List? bytes = f.bytes;
      if (bytes == null && f.readStream != null) {
        final chunks = <int>[];
        await for (final c in f.readStream!) {
          chunks.addAll(c);
        }
        bytes = Uint8List.fromList(chunks);
      }
      if (bytes == null) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('讀取檔案失敗（無法取得檔案內容）')),
        );
        return;
      }

      // 解碼（UTF-8/latin1）
      String content;
      try {
        content = utf8.decode(bytes);
      } catch (_) {
        content = latin1.decode(bytes, allowInvalid: true);
      }

      if (kIsWeb) {
        await _importCsvWeb(content);      // Web：分段讓出事件迴圈
      } else {
        await _importCsvIsolate(content);  // 手機/桌面：Isolate
      }
    } catch (e) {
      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).maybePop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('匯入失敗：$e')),
      );
    }
  }

  // ---- Web：分段解析，只讀獎號欄位，避免 UI 卡住/誤抓 ----
  Future<void> _importCsvWeb(String content) async {
    double progress = 0.0;
    int done = 0, total = 0, ok = 0, skip = 0;
    StateSetter? dialogSet;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => StatefulBuilder(
        builder: (ctx, setState) {
          dialogSet = setState;
          return AlertDialog(
            title: const Text('匯入中…'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                LinearProgressIndicator(value: total > 0 ? progress : null),
                const SizedBox(height: 8),
                Text(total > 0
                    ? '已處理 $done / $total 行（有效 $ok、略過 $skip）'
                    : '正在分析檔案…'),
              ],
            ),
          );
        },
      ),
    );

    // 先轉 rows 以便讀標題
    final rows = const CsvToListConverter(
      shouldParseNumbers: false,
      eol: '\n',
    ).convert(content);

    // 找標題與起始列
    int startRow = 0;
    List<dynamic>? header;
    if (rows.isNotEmpty) {
      final f0 = (rows[0].isNotEmpty ? rows[0][0] : '').toString();
      if (f0.contains('遊戲名稱') || f0.toLowerCase().contains('game')) {
        header = rows[0];
        startRow = 1;
      }
    }

    // 找出「獎號1..獎號20」「超級獎號」欄位索引
    List<int> numberIdx = [];
    int? superIdx;
    if (header != null) {
      for (int i = 0; i < header.length; i++) {
        final h = (header[i] ?? '').toString();
        if (RegExp(r'^獎號\s*\d+$').hasMatch(h)) {
          numberIdx.add(i);
        } else if (h.contains('超級獎號')) {
          superIdx = i;
        }
      }
      numberIdx.sort();
    }
    // 若抓不到標題，套用常見固定結構：6 個 meta + 20 顆 + 1 超級
    numberIdx = numberIdx.isEmpty ? List.generate(20, (k) => 6 + k) : numberIdx;
    superIdx ??= 26;

    total = (rows.length - startRow).clamp(0, rows.length);
    dialogSet?.call(() {
      progress = 0.0;
      done = ok = skip = 0;
    });

    final existing = {
      for (final e in draws) (e['nums'] as List).cast<int>().join(',')
    };
    int added = 0;

    const chunk = 800;
    for (int i = startRow; i < rows.length; i += chunk) {
      final end = (i + chunk < rows.length) ? i + chunk : rows.length;
      final slice = rows.sublist(i, end);

      for (final row in slice) {
        final nums = <int>[];
        for (final idx in numberIdx) {
          if (idx >= row.length) continue;
          final v = int.tryParse((row[idx] ?? '').toString());
          if (v != null && v >= 1 && v <= 80) {
            if (!nums.contains(v)) nums.add(v);
          }
        }
        if (nums.length != K) { skip++; done++; continue; }

        int? superNum;
        if (superIdx != null && superIdx < row.length) {
          final sv = int.tryParse((row[superIdx] ?? '').toString());
          if (sv != null && sv >= 1 && sv <= 80 && !nums.contains(sv)) {
            superNum = sv;
          }
        }

        nums.sort();
        final key = nums.join(',');
        if (!existing.contains(key)) {
          draws.insert(0, {'nums': nums, 'super': superNum});
          existing.add(key);
          added++;
          ok++;
        } else {
          skip++;
        }
        done++;
      }

      dialogSet?.call(() {
        progress = total > 0 ? (done / total).clamp(0.0, 1.0) : 0.0;
      });
      await Future.delayed(Duration.zero); // 讓 UI 重繪
    }

    await _save();
    if (!mounted) return;
    Navigator.of(context, rootNavigator: true).maybePop();
    setState(() {});
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('CSV 匯入完成：成功 $ok（新增 $added），略過 $skip')),
    );
  }

  // ---- 手機/桌面：Isolate 解析（只讀獎號欄位）----
  Future<void> _importCsvIsolate(String content) async {
    double progress = 0.0;
    int done = 0, total = 0, ok = 0, skip = 0;
    StateSetter? dialogSet;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => StatefulBuilder(
        builder: (ctx, setState) {
          dialogSet = setState;
          return AlertDialog(
            title: const Text('匯入中…'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                LinearProgressIndicator(value: total > 0 ? progress : null),
                const SizedBox(height: 8),
                Text(total > 0
                    ? '已處理 $done / $total 行（有效 $ok、略過 $skip）'
                    : '正在分析檔案…'),
              ],
            ),
          );
        },
      ),
    );

    final rp = ReceivePort();
    await Isolate.spawn(_csvIsolateEntry, {
      'sendPort': rp.sendPort,
      'content': content,
      'chunk': 800,
    });

    final parsedBatches = <Map<String, dynamic>>[];

    await for (final msg in rp) {
      final m = msg as Map;
      switch (m['type'] as String) {
        case 'total':
          total = m['total'] as int;
          dialogSet?.call(() {
            progress = 0.0;
            done = ok = skip = 0;
          });
          break;
        case 'progress':
          done = m['done'] as int;
          ok = m['ok'] as int;
          skip = m['skip'] as int;
          dialogSet?.call(() {
            progress = total > 0 ? (done / total).clamp(0.0, 1.0) : 0.0;
          });
          break;
        case 'batch':
          parsedBatches.addAll(
              (m['parsed'] as List).cast<Map<String, dynamic>>());
          break;
        case 'done':
          ok = m['ok'] as int;
          skip = m['skip'] as int;

          final existing = {
            for (final e in draws) (e['nums'] as List).cast<int>().join(',')
          };
          int added = 0;
          for (final item in parsedBatches) {
            final nums = (item['nums'] as List).cast<int>()..sort();
            final key = nums.join(',');
            if (!existing.contains(key)) {
              draws.insert(0, {'nums': nums, 'super': item['super']});
              existing.add(key);
              added++;
            }
          }
          await _save();

          if (mounted) {
            Navigator.of(context, rootNavigator: true).maybePop();
            setState(() {});
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('CSV 匯入完成：成功 $ok（新增 $added），略過 $skip')),
            );
          }
          rp.close();
          return;
      }
    }
  }

  /// Isolate 入口：逐行解析 CSV（只讀獎號欄位）
  static void _csvIsolateEntry(Map args) {
    final SendPort out = args['sendPort'] as SendPort;
    final String content = args['content'] as String;
    final int chunk = (args['chunk'] as int?) ?? 800;

    final rows = const CsvToListConverter(
      shouldParseNumbers: false,
      eol: '\n',
    ).convert(content);

    // 標題與索引
    int startRow = 0;
    List<dynamic>? header;
    if (rows.isNotEmpty) {
      final first = (rows[0].isNotEmpty ? rows[0][0] : '').toString();
      if (first.contains('遊戲名稱') || first.toLowerCase().contains('game')) {
        header = rows[0];
        startRow = 1;
      }
    }

    List<int> numberIdx = [];
    int? superIdx;
    if (header != null) {
      for (int i = 0; i < header.length; i++) {
        final h = (header[i] ?? '').toString();
        if (RegExp(r'^獎號\s*\d+$').hasMatch(h)) {
          numberIdx.add(i);
        } else if (h.contains('超級獎號')) {
          superIdx = i;
        }
      }
      numberIdx.sort();
    }
    numberIdx = numberIdx.isEmpty ? List.generate(20, (k) => 6 + k) : numberIdx;
    superIdx ??= 26;

    final total = (rows.length - startRow).clamp(0, rows.length);
    out.send({'type': 'total', 'total': total});

    final parsedBatch = <Map<String, dynamic>>[];
    int ok = 0, skip = 0, done = 0;

    for (int i = startRow; i < rows.length; i++) {
      final row = rows[i];

      final nums = <int>[];
      for (final idx in numberIdx) {
        if (idx >= row.length) continue;
        final v = int.tryParse((row[idx] ?? '').toString());
        if (v != null && v >= 1 && v <= 80) {
          if (!nums.contains(v)) nums.add(v);
        }
      }
      if (nums.length != K) { skip++; done++; continue; }

      int? superNum;
      if (superIdx != null && superIdx < row.length) {
        final sv = int.tryParse((row[superIdx] ?? '').toString());
        if (sv != null && sv >= 1 && sv <= 80 && !nums.contains(sv)) {
          superNum = sv;
        }
      }

      nums.sort();
      parsedBatch.add({'nums': nums, 'super': superNum});
      ok++; done++;

      if (done % chunk == 0) {
        out.send({'type': 'progress', 'done': done, 'ok': ok, 'skip': skip});
        if (parsedBatch.isNotEmpty) {
          out.send({'type': 'batch', 'parsed': List<Map<String, dynamic>>.from(parsedBatch)});
          parsedBatch.clear();
        }
      }
    }

    if (parsedBatch.isNotEmpty) {
      out.send({'type': 'batch', 'parsed': parsedBatch});
    }
    out.send({'type': 'done', 'ok': ok, 'skip': skip});
  }

  // ---- 貼上匯入 ----
  Future<void> _pasteImport() async {
    final rows = await showDialog<List<List<int>>>(
      context: context,
      builder: (_) => const _PasteDialog(),
    );
    if (rows == null || rows.isEmpty) return;

    int ok = 0;
    for (final r in rows) {
      if (r.length == K) {
        _addDraw(r);
        ok++;
      }
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('匯入完成：成功 $ok 筆')),
    );
  }

  // ---- UI ----
  @override
  Widget build(BuildContext context) {
    final recent = _recentDraws();
    final totalPeriods = recent.length; // 分母：期數

    final freq = _countFreq();
    final probs = [
      0.0,
      for (int i = 1; i <= N; i++) safeRatio(freq[i] ?? 0, totalPeriods)
    ];
    final values = probs.skip(1).toList();
    final maxP = values.isNotEmpty ? values.reduce(max) : 0.0;
    final minP = values.isNotEmpty ? values.reduce(min) : 0.0;

    final superFreq = _countSuperFreq();
    final topSuper = superFreq.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final topSuperText = topSuper.isEmpty
        ? '（尚無資料）'
        : topSuper.take(3).map((e) => '${e.key}（${e.value} 次）').join('、');

    return Scaffold(
      appBar: AppBar(
        title: const Text('Bingo 歷史熱度（近 N 期）'),
        actions: [
          IconButton(
            tooltip: '匯入 CSV 檔',
            icon: const Icon(Icons.upload_file),
            onPressed: _importCsv,
          ),
          IconButton(
            tooltip: '貼上匯入（多筆）',
            icon: const Icon(Icons.file_upload),
            onPressed: _pasteImport,
          ),
          IconButton(
            tooltip: '新增一筆',
            icon: const Icon(Icons.add),
            onPressed: () async {
              final res = await showDialog<_AddResult>(
                context: context,
                builder: (_) => const _AddDrawDialog(),
              );
              if (res != null && res.nums.length == K) {
                _addDraw(res.nums, superNum: res.superNum);
              }
            },
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          children: [
            Row(
              children: [
                const Text('視窗：'),
                const SizedBox(width: 8),
                DropdownButton<int>(
                  value: sampleSize,
                  items: const [50, 100, 200, 500, -1]
                      .map((e) => DropdownMenuItem(
                            value: e,
                            child: Text(e == -1 ? '全部' : '近 $e 期'),
                          ))
                      .toList(),
                  onChanged: (v) => setState(() => sampleSize = v ?? 100),
                ),
                const Spacer(),
                Text('樣本：$totalPeriods 期（理論單號約 25%）'),
                const SizedBox(width: 12),
                Flexible(
                  child: Text(
                    '超級獎號 Top3：$topSuperText',
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: GridView.builder(
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 8,
                  childAspectRatio: 1.25,
                  crossAxisSpacing: 8,
                  mainAxisSpacing: 8,
                ),
                itemCount: N,
                itemBuilder: (_, idx) {
                  final n = idx + 1;
                  final p = probs[n]; // 0..1
                  final t = (maxP - minP) > 0 ? (p - minP) / (maxP - minP) : 0.5;
                  final color =
                      Color.lerp(Colors.blue.shade100, Colors.red.shade400, t)!;
                  return Container(
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(n.toString(),
                              style:
                                  const TextStyle(fontWeight: FontWeight.bold)),
                          Text('${(p * 100).toStringAsFixed(1)}%'),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              height: 180,
              child: BarChart(
                BarChartData(
                  maxY: (totalPeriods == 0) ? 0.4 : null,
                  barTouchData: BarTouchData(enabled: false),
                  titlesData: FlTitlesData(
                    leftTitles:
                        const AxisTitles(sideTitles: SideTitles(showTitles: true)),
                    bottomTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        reservedSize: 18,
                        getTitlesWidget: (v, meta) {
                          final i = v.toInt();
                          return i % 5 == 0 ? Text('$i') : const SizedBox.shrink();
                        },
                      ),
                    ),
                  ),
                  gridData: const FlGridData(show: true),
                  barGroups: [
                    for (int i = 1; i <= 80; i++)
                      BarChartGroupData(
                        x: i,
                        barRods: [
                          BarChartRodData(toY: probs[i].isFinite ? probs[i] : 0.0)
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Dialogs ----------

class _AddResult {
  final List<int> nums;
  final int? superNum;
  _AddResult(this.nums, this.superNum);
}

class _AddDrawDialog extends StatefulWidget {
  const _AddDrawDialog();
  @override
  State<_AddDrawDialog> createState() => _AddDrawDialogState();
}

class _AddDrawDialogState extends State<_AddDrawDialog> {
  final numsController = TextEditingController();
  final superController = TextEditingController();
  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新增一筆（20 顆 1..80）'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: numsController,
            decoration: const InputDecoration(
              hintText: '例如：1 2 3 ... 20（空白或逗號分隔）',
              labelText: '20 顆號碼',
            ),
            maxLines: 2,
          ),
          const SizedBox(height: 8),
          TextField(
            controller: superController,
            decoration: const InputDecoration(
              hintText: '可留空',
              labelText: '超級獎號（1..80，可選）',
            ),
            keyboardType: TextInputType.number,
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            final toks = numsController.text
                .replaceAll(RegExp(r'[^0-9,\s\t]'), ' ')
                .split(RegExp(r'[\s,]+'));
            final set = <int>{};
            for (final t in toks) {
              if (t.isEmpty) continue;
              final v = int.tryParse(t);
              if (v != null && v >= 1 && v <= 80) set.add(v);
            }
            if (set.length != _StatsHomeState.K) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('需要 20 個 1..80 的不重複數字')),
              );
              return;
            }
            final superText = superController.text.trim();
            int? superNum;
            if (superText.isNotEmpty) {
              final v = int.tryParse(superText);
              if (v == null || v < 1 || v > 80) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('超級獎號需為 1..80')),
                );
                return;
              }
              superNum = v;
            }
            Navigator.pop(context, _AddResult(set.toList()..sort(), superNum));
          },
          child: const Text('加入'),
        ),
      ],
    );
  }
}

class _PasteDialog extends StatefulWidget {
  const _PasteDialog();
  @override
  State<_PasteDialog> createState() => _PasteDialogState();
}

class _PasteDialogState extends State<_PasteDialog> {
  final _controller = TextEditingController();
  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('貼上歷史開獎（每行 20 顆）'),
      content: SizedBox(
        width: 520,
        child: TextField(
          controller: _controller,
          maxLines: 12,
          decoration: const InputDecoration(
            hintText:
                '每行 20 個 1..80 的數字，空白/逗號皆可。\n例如：\n1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20\n3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57,60',
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            final lines = const LineSplitter().convert(_controller.text);
            final out = <List<int>>[];
            for (final line in lines) {
              final toks = line
                  .replaceAll(RegExp(r'[^0-9,\s\t]'), ' ')
                  .split(RegExp(r'[\s,]+'));
              final set = <int>{};
              for (final t in toks) {
                if (t.isEmpty) continue;
                final v = int.tryParse(t);
                if (v != null && v >= 1 && v <= 80) set.add(v);
                if (set.length == _StatsHomeState.K) break;
              }
              if (set.length == _StatsHomeState.K) {
                out.add(set.toList()..sort());
              }
            }
            Navigator.pop(context, out);
          },
          child: const Text('匯入'),
        ),
      ],
    );
  }
}
