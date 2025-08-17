import 'dart:convert';
import 'dart:io' show File;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:file_picker/file_picker.dart';

/// ===================== Data Model =====================
class Draw {
  final List<int> nums; // 20 balls
  final int? superBall; // optional 1..80

  Draw({required this.nums, this.superBall})
      : assert(nums.length == 20, 'nums must be 20');

  Map<String, dynamic> toJson() => {
        'nums': nums,
        if (superBall != null) 'super': superBall,
      };

  static Draw fromJson(dynamic e) {
    if (e is List) {
      final nums = List<int>.from(e)..sort();
      return Draw(nums: nums);
    }
    final m = e as Map<String, dynamic>;
    final nums = List<int>.from(m['nums'] as List)..sort();
    final sb = m['super'];
    return Draw(nums: nums, superBall: sb is int ? sb : null);
  }
}

/// ===================== App =====================
void main() => runApp(const StatsApp());

class StatsApp extends StatelessWidget {
  const StatsApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bingo 歷史熱度',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.teal),
      home: const StatsHome(),
    );
  }
}

class StatsHome extends StatefulWidget {
  const StatsHome({super.key});
  @override
  State<StatsHome> createState() => _StatsHomeState();
}

class _StatsHomeState extends State<StatsHome> {
  List<Draw> draws = [];
  int sampleSize = 100;

  // ---------- Storage: File (mobile) or SharedPreferences (web) ----------
  static const _spKey = 'draws_json';

  Future<String?> _readRaw() async {
    if (kIsWeb) {
      final sp = await SharedPreferences.getInstance();
      return sp.getString(_spKey);
    } else {
      final dir = await getApplicationDocumentsDirectory();
      final f = File('${dir.path}/draws.json');
      if (!await f.exists()) return null;
      return f.readAsString();
    }
  }

  Future<void> _writeRaw(String content) async {
    if (kIsWeb) {
      final sp = await SharedPreferences.getInstance();
      await sp.setString(_spKey, content);
    } else {
      final dir = await getApplicationDocumentsDirectory();
      final f = File('${dir.path}/draws.json');
      await f.writeAsString(content);
    }
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final txt = await _readRaw();
      if (txt == null || txt.isEmpty) return;
      final data = jsonDecode(txt) as List<dynamic>;
      setState(() {
        draws = data.map(Draw.fromJson).toList();
      });
    } catch (_) {/* ignore */}
  }

  Future<void> _save() async {
    final data = draws.map((d) => d.toJson()).toList();
    await _writeRaw(jsonEncode(data));
  }

  void _addDraw(Draw d) {
    setState(() {
      draws.insert(0, d); // 最新在最前
    });
  }

  void _addMany(List<Draw> list) {
    setState(() {
      draws.insertAll(0, list.reversed); // 保持原順序：舊在後、新在前
    });
  }

  // ---------- Stats ----------
  Map<int, int> _countFreq() {
    final freq = <int, int>{};
    final recent = draws.take(sampleSize);
    for (final d in recent) {
      for (final n in d.nums) {
        freq[n] = (freq[n] ?? 0) + 1;
      }
    }
    return freq;
  }

  Map<int, int> _countSuperFreq() {
    final freq = <int, int>{};
    final recent = draws.take(sampleSize);
    for (final d in recent) {
      final s = d.superBall;
      if (s != null) freq[s] = (freq[s] ?? 0) + 1;
    }
    return freq;
  }

  double _safeRatio(int count, int total) {
    if (total <= 0) return 0.0;
    final v = count / total;
    return v.isFinite ? v.clamp(0.0, 1.0) : 0.0;
  }

  String _top3Text(Map<int, int> freq) {
    if (freq.isEmpty) return '—';
    final list = freq.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final top = list.take(3).toList();
    return top.map((e) => '${e.key}（${e.value} 次）').join('、');
  }

  // ---------- CSV Import：分批解析 + 進度條（Web 不卡） ----------
  Future<void> _importCsv() async {
    try {
      final picked = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['csv'],
        withData: kIsWeb,
      );
      if (picked == null) return;

      String csvText;
      if (kIsWeb) {
        final bytes = picked.files.single.bytes;
        if (bytes == null) return;
        const bom = [0xEF, 0xBB, 0xBF];
        final b = (bytes.length >= 3 &&
                bytes[0] == bom[0] &&
                bytes[1] == bom[1] &&
                bytes[2] == bom[2])
            ? bytes.sublist(3)
            : bytes;
        csvText = utf8.decode(b, allowMalformed: true);
      } else {
        final path = picked.files.single.path;
        if (path == null) return;
        csvText = await File(path).readAsString();
      }

      double progress = 0.0;
      late StateSetter setModal;
      showDialog(
        context: context,
        barrierDismissible: false,
        builder: (_) => StatefulBuilder(
          builder: (_, _set) {
            setModal = _set;
            return AlertDialog(
              title: const Text('匯入中…'),
              content: SizedBox(
                width: 320,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    LinearProgressIndicator(
                      value: progress == 0 ? null : progress,
                    ),
                    const SizedBox(height: 12),
                    Text('${(progress * 100).toStringAsFixed(0)}%'),
                  ],
                ),
              ),
            );
          },
        ),
      );

      await Future<void>.delayed(const Duration(milliseconds: 50));

      final parsed = await _parseCsvWithYield(
        csvText,
        onProgress: (p) {
          progress = p;
          setModal(() {});
        },
      );

      if (context.mounted) Navigator.of(context).pop();

      if (parsed.isEmpty) {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('CSV 解析不到有效資料')),
        );
        return;
      }

      _addMany(parsed);
      await _save();

      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('CSV 匯入完成：成功 ${parsed.length} 筆')),
      );
    } catch (e) {
      if (Navigator.of(context).canPop()) {
        Navigator.of(context).pop();
      }
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('CSV 匯入失敗：$e')),
      );
    }
  }

  /// 逐行分批解析（第21顆視為超級獎號；前20顆去重），每 400 行讓出事件迴圈並回報進度
  Future<List<Draw>> _parseCsvWithYield(
    String csvText, {
    void Function(double progress)? onProgress,
  }) async {
    final lines = const LineSplitter().convert(csvText);
    final out = <Draw>[];
    final total = lines.isEmpty ? 1 : lines.length;
    int done = 0;

    for (final line in lines) {
      done++;

      final matches = RegExp(r'\d+').allMatches(line);
      final vals = <int>[];
      for (final m in matches) {
        final v = int.tryParse(m.group(0)!);
        if (v != null && v >= 1 && v <= 80) vals.add(v);
      }

      if (vals.length >= 20) {
        int? superBall;
        if (vals.length >= 21) {
          superBall = vals.last;
          vals.removeLast();
        }
        final set = <int>{};
        for (final v in vals) {
          set.add(v);
          if (set.length == 20) break;
        }
        if (set.length == 20) {
          out.add(Draw(nums: set.toList()..sort(), superBall: superBall));
        }
      }

      if (done % 400 == 0) {
        onProgress?.call(done / total);
        await Future<void>.delayed(Duration.zero);
      }
    }
    onProgress?.call(1.0);
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final freq = _countFreq();
    final superFreq = _countSuperFreq();

    final issues = draws.take(sampleSize).length;
    final totalBalls = issues * 20;
    final probs = List<double>.generate(
      81,
      (i) => i == 0 ? 0.0 : _safeRatio(freq[i] ?? 0, totalBalls),
    );
    final maxP = probs.skip(1).fold<double>(0.0, (m, e) => e > m ? e : m);
    final minP = probs.skip(1).fold<double>(1.0, (m, e) => e < m ? e : m);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Bingo 歷史熱度（近 N 期）'),
        actions: [
          IconButton(
            tooltip: '貼上匯入（多筆）',
            icon: const Icon(Icons.assignment),
            onPressed: () async {
              final rows = await showDialog<List<Draw>>(
                context: context,
                builder: (_) => const _PasteDialog(),
              );
              if (rows != null && rows.isNotEmpty) {
                _addMany(rows);
                await _save();
                if (!context.mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('匯入完成：成功 ${rows.length} 筆')),
                );
              }
            },
          ),
          IconButton(
            tooltip: '匯入 CSV',
            icon: const Icon(Icons.upload_file),
            onPressed: _importCsv,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(12, 8, 12, 0),
            child: Row(
              children: [
                const Text('視窗：'),
                const SizedBox(width: 6),
                DropdownButton<int>(
                  value: sampleSize,
                  items: const [50, 100, 200, 500]
                      .map((e) =>
                          DropdownMenuItem(value: e, child: Text('近 $e 期')))
                      .toList(),
                  onChanged: (v) => setState(() => sampleSize = v ?? 100),
                ),
                const SizedBox(width: 12),
                Text('樣本：$issues 期（理論單號約 25%）',
                    style: const TextStyle(fontSize: 12)),
                const Spacer(),
                Text(
                  '超級獎號 Top3：${_top3Text(superFreq)}',
                  style: const TextStyle(fontSize: 12),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: GridView.count(
              padding: const EdgeInsets.all(8),
              crossAxisCount: 8,
              children: [
                for (var i = 1; i <= 80; i++)
                  Builder(builder: (context) {
                    final p = probs[i];
                    final t =
                        (maxP - minP) > 0 ? (p - minP) / (maxP - minP) : 0.5;
                    final color = Color.lerp(
                        Colors.blue.shade100, Colors.red.shade400, t)!;
                    final percent =
                        (totalBalls == 0) ? 0.0 : (freq[i] ?? 0) / totalBalls;
                    return Card(
                      color: color,
                      child: Center(
                        child: Text(
                          '$i\n${(percent * 100).toStringAsFixed(1)}%\n(${freq[i] ?? 0} 次)',
                          textAlign: TextAlign.center,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    );
                  }),
              ],
            ),
          ),
          _BarSection(probs: probs, drawsEmpty: draws.isEmpty),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        tooltip: '快速新增（20顆 + 超級獎號）',
        onPressed: () async {
          final result = await showDialog<Map<String, dynamic>>(
            context: context,
            builder: (_) => const _QuickAddDialog(),
          );
          if (result != null &&
              result["nums"] is List<int> &&
              (result["nums"] as List<int>).length == 20) {
            final nums = (result["nums"] as List<int>)..sort();
            final s = result["super"] as int?;
            _addDraw(Draw(nums: nums, superBall: s));
            await _save();
            if (!context.mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('已新增 1 筆（超級獎號：${s ?? "無"}）')),
            );
          }
        },
        child: const Icon(Icons.add),
      ),
    );
  }
}

/// ===================== Bar Section =====================
class _BarSection extends StatelessWidget {
  final List<double> probs; // index 1..80 used
  final bool drawsEmpty;
  const _BarSection({required this.probs, required this.drawsEmpty});

  @override
  Widget build(BuildContext context) {
    final chartWidth = 80 * 12.0;
    return SizedBox(
      height: 200,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SizedBox(
          width: chartWidth,
          child: BarChart(
            BarChartData(
              maxY: drawsEmpty ? 0.35 : null,
              barTouchData: BarTouchData(enabled: false),
              gridData: const FlGridData(show: true),
              titlesData: FlTitlesData(
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 32,
                    getTitlesWidget: (v, meta) =>
                        Text(v.toStringAsFixed(2), style: const TextStyle(fontSize: 10)),
                  ),
                ),
                rightTitles:
                    const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                topTitles:
                    const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 18,
                    getTitlesWidget: (v, meta) {
                      final i = v.toInt();
                      if (i <= 0 || i > 80 || i % 5 != 0) {
                        return const SizedBox.shrink();
                      }
                      return SideTitleWidget(
                        axisSide: meta.axisSide,
                        space: 4,
                        child: Text('$i', style: const TextStyle(fontSize: 10)),
                      );
                    },
                  ),
                ),
              ),
              barGroups: [
                for (int i = 1; i <= 80; i++)
                  BarChartGroupData(
                    x: i,
                    barRods: [
                      BarChartRodData(
                        toY: probs[i].isFinite ? probs[i] : 0.0,
                        width: 8,
                      ),
                    ],
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// ===================== Quick Add (20 + Super) =====================
class _QuickAddDialog extends StatefulWidget {
  const _QuickAddDialog();
  @override
  State<_QuickAddDialog> createState() => _QuickAddDialogState();
}

class _QuickAddDialogState extends State<_QuickAddDialog> {
  final Set<int> sel = {};
  int? superBall;

  void _toggle(int n) {
    setState(() {
      if (sel.contains(n)) {
        sel.remove(n);
      } else if (sel.length < 20) {
        sel.add(n);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Row(
        children: [
          const Text('快速新增（20 顆 + 超級獎號）'),
          const Spacer(),
          Text('${sel.length}/20', style: const TextStyle(fontSize: 14)),
        ],
      ),
      content: SizedBox(
        width: 540,
        height: 520,
        child: Column(
          children: [
            Expanded(
              child: GridView.count(
                crossAxisCount: 8,
                childAspectRatio: 1.2,
                children: [
                  for (int i = 1; i <= 80; i++)
                    GestureDetector(
                      onTap: () => _toggle(i),
                      child: Card(
                        color: sel.contains(i)
                            ? Colors.teal.shade400
                            : Colors.grey.shade300,
                        child: Center(
                          child: Text(
                            '$i',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: sel.contains(i)
                                  ? Colors.white
                                  : Colors.black87,
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            // 超級獎號：下拉選單（不會擋住）
            Row(
              children: [
                const Text('超級獎號：'),
                const SizedBox(width: 8),
                DropdownButton<int>(
                  value: superBall,
                  hint: const Text('選擇 1~80'),
                  items: [
                    for (int i = 1; i <= 80; i++)
                      DropdownMenuItem(value: i, child: Text('$i')),
                  ],
                  onChanged: (v) => setState(() => superBall = v),
                ),
                const Spacer(),
                TextButton(
                  onPressed: () {
                    final pool = List<int>.generate(80, (i) => i + 1)..shuffle();
                    setState(() => superBall = pool.first);
                  },
                  child: const Text('隨機一顆'),
                ),
              ],
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () {
            setState(() {
              sel.clear();
              superBall = null;
            });
          },
          child: const Text('清空'),
        ),
        TextButton(
          onPressed: () {
            final rnd = List<int>.generate(80, (i) => i + 1)..shuffle();
            for (final v in rnd) {
              if (sel.length >= 20) break;
              sel.add(v);
            }
            superBall ??=
                rnd.firstWhere((v) => !sel.contains(v), orElse: () => rnd[0]);
            setState(() {});
          },
          child: const Text('隨機'),
        ),
        FilledButton(
          onPressed: (sel.length == 20)
              ? () {
                  final out = {
                    'nums': sel.toList()..sort(),
                    'super': superBall,
                  };
                  Navigator.pop(context, out);
                }
              : null,
          child: const Text('確定'),
        ),
      ],
    );
  }
}

/// ===================== Paste Import (20 or 21 per line) =====================
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
      title: const Text('貼上歷史開獎（每行 20 或 21 顆；第21顆為超級獎號）'),
      content: SizedBox(
        width: 520,
        child: TextField(
          controller: _controller,
          maxLines: 12,
          decoration: const InputDecoration(
            hintText:
                '每行：20 顆一般獎號（1..80），可加第 21 顆為超級獎號。\n空白/逗號皆可。\n例：\n1 2 3 ... 20  |  1,3,5,...,39,41 67',
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          child: const Text('匯入'),
          onPressed: () {
            final lines = const LineSplitter().convert(_controller.text);
            final out = <Draw>[];
            for (final line in lines) {
              final matches = RegExp(r'\d+').allMatches(line);
              final values = <int>[];
              for (final m in matches) {
                final v = int.tryParse(m.group(0)!);
                if (v != null && v >= 1 && v <= 80) values.add(v);
              }
              if (values.isEmpty) continue;

              int? superBall;
              if (values.length >= 21) {
                superBall = values.last;
                values.removeLast();
              }
              final set = <int>{};
              for (final v in values) {
                if (set.length == 20) break;
                set.add(v);
              }
              if (set.length == 20) {
                out.add(Draw(nums: set.toList()..sort(), superBall: superBall));
              }
            }
            Navigator.pop(context, out);
          },
        ),
      ],
    );
  }
}
