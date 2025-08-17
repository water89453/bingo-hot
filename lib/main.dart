import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:file_picker/file_picker.dart';
import 'package:csv/csv.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:path_provider/path_provider.dart';

void main() => runApp(const StatsApp());

class StatsApp extends StatelessWidget {
  const StatsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bingo 歷史熱度',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.teal),
      home: const StatsHome(),
      debugShowCheckedModeBanner: false,
    );
  }
}

/// 一期資料：20 顆號碼 + 超級獎號（最後一顆）
class Draw {
  final List<int> balls; // 20 顆（1..80，不重複、排序）
  final int superBall;   // 1..80（通常為 balls 的最後一顆）

  const Draw({required this.balls, required this.superBall});

  Map<String, dynamic> toJson() => {
        'balls': balls,
        'super': superBall,
      };

  factory Draw.fromJson(Map<String, dynamic> json) {
    final b = List<int>.from(json['balls'] as List);
    final s = json['super'] as int? ?? b.last;
    return Draw(balls: b, superBall: s);
  }
}

class StatsHome extends StatefulWidget {
  const StatsHome({super.key});
  @override
  State<StatsHome> createState() => _StatsHomeState();
}

class _StatsHomeState extends State<StatsHome> {
  // 狀態
  final _spKey = 'bingo_draws_v3';
  List<Draw> _draws = []; // 新的在最前（index 0）
  int sampleSize = 100;

  // 讀/寫 --------------------------------------------------------------

  Future<String?> _readRaw() async {
    try {
      final sp = await SharedPreferences.getInstance();
      return sp.getString(_spKey);
    } catch (_) {
      return null;
    }
  }

  Future<void> _writeRaw(String content) async {
    try {
      final sp = await SharedPreferences.getInstance();
      await sp.setString(_spKey, content);
    } catch (_) {}
  }

  Future<void> _saveAll() async {
    final data = _draws.map((e) => e.toJson()).toList();
    await _writeRaw(jsonEncode(data));
  }

  Future<void> _loadAll() async {
    try {
      final raw = await _readRaw();
      if (raw == null) return;
      final list = (jsonDecode(raw) as List)
          .map((e) => Draw.fromJson(Map<String, dynamic>.from(e)))
          .toList();
      setState(() => _draws = list);
    } catch (_) {}
  }

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  // 統計 --------------------------------------------------------------

  Map<int, int> _countFreq() {
    final freq = <int, int>{};
    final recent = _draws.take(sampleSize);
    for (final d in recent) {
      for (final n in d.balls) {
        freq[n] = (freq[n] ?? 0) + 1;
      }
    }
    return freq;
  }

  Map<int, int> _countSuperFreq() {
    final freq = <int, int>{};
    final recent = _draws.take(sampleSize);
    for (final d in recent) {
      freq[d.superBall] = (freq[d.superBall] ?? 0) + 1;
    }
    return freq;
  }

  // 新增 --------------------------------------------------------------

  void _addOne(Draw d) {
    setState(() => _draws.insert(0, d));
  }

  void _addMany(List<Draw> list) {
    setState(() => _draws = List<Draw>.from(list)..addAll(_draws));
  }

  // 小工具 ------------------------------------------------------------

  double _safeRatio(int count, int total) {
    if (total <= 0) return 0.0;
    final v = count / total;
    return v.isFinite ? v.clamp(0.0, 1.0) : 0.0;
  }

  String _pct(int cnt, int totalIssues) {
    final p = _safeRatio(cnt, totalIssues) * 100.0;
    return '${p.toStringAsFixed(1)}%';
  }

  // 介面 --------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final issues = _draws.take(sampleSize).length;
    final freq = _countFreq();
    final superFreq = _countSuperFreq();
    final totalBalls = issues * 20;

    // 機率（0~1）
    final probs = List<double>.generate(
      81,
      (i) => i == 0 ? 0.0 : _safeRatio(freq[i] ?? 0, totalBalls),
    );

    final maxP = probs.skip(1).fold<double>(0, (a, b) => a > b ? a : b);
    final minP = probs.skip(1).fold<double>(1, (a, b) => a < b ? a : b);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Bingo 歷史熱度（近 N 期）'),
        actions: [
          // 文字貼上匯入
          IconButton(
            tooltip: '貼上匯入（每行 20 顆）',
            icon: const Icon(Icons.content_paste_go),
            onPressed: () async {
              final rows = await showDialog<List<Draw>>(
                context: context,
                builder: (_) => const _PasteDialog(),
              );
              if (rows != null && rows.isNotEmpty) {
                _addMany(rows);
                await _saveAll();
                if (!mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('貼上匯入完成：${rows.length} 筆')),
                );
              }
            },
          ),
          // 匯入 CSV
          IconButton(
            tooltip: '匯入 CSV',
            icon: const Icon(Icons.table_view),
            onPressed: () async {
              try {
                final picked = await FilePicker.platform.pickFiles(
                  type: FileType.custom,
                  allowedExtensions: ['csv', 'txt'],
                  allowMultiple: false,
                  withData: kIsWeb,
                );
                if (picked == null) return;
                String text;
                if (kIsWeb) {
                  final bytes = picked.files.single.bytes!;
                  text = utf8.decode(bytes, allowMalformed: true);
                } else {
                  final path = picked.files.single.path!;
                  text = await File(path).readAsString();
                }

                final rows = const CsvToListConverter(
                  shouldParseNumbers: false,
                  eol: '\n',
                ).convert(text);

                // 嘗試自動找出「獎號起始欄位」
                // 支援：獎號1..獎號20 / 第1顆..第20顆 / 1..20 等
                int startIdx = -1;
                for (int c = 0; c < (rows.firstOrNull?.length ?? 0); c++) {
                  final hdr = rows.firstOrNull?[c]?.toString() ?? '';
                  final h = hdr.replaceAll(' ', '');
                  if (RegExp(r'^(獎號?1|第?1顆|1)$').hasMatch(h)) {
                    startIdx = c;
                    break;
                  }
                }
                // 若第一列不是標頭，預設從第 6 欄開始（常見格式）
                if (startIdx == -1) startIdx = 6;

                final parsed = <Draw>[];
                for (int i = 0; i < rows.length; i++) {
                  final r = rows[i];
                  if (r.length < startIdx + 21) continue; // 至少 20 + 1
                  // 取連續 20 顆
                  final set = <int>{};
                  for (int j = 0; j < 20; j++) {
                    final cell = (r[startIdx + j] ?? '').toString().trim();
                    final v = int.tryParse(cell);
                    if (v != null && v >= 1 && v <= 80) set.add(v);
                  }
                  if (set.length != 20) continue;
                  final balls = set.toList()..sort();

                  // 超級獎號：優先抓「獎號21 / 超級獎號 / 第21顆」欄
                  int? superBall;
                  final supCell = (r.length > startIdx + 20)
                      ? r[startIdx + 20].toString().trim()
                      : '';
                  final sup = int.tryParse(supCell);
                  if (sup != null && sup >= 1 && sup <= 80) {
                    superBall = sup;
                  } else {
                    // 若沒有，就以該列最後一個有效數字當超級獎號
                    superBall = balls.last;
                  }
                  parsed.add(Draw(balls: balls, superBall: superBall));
                }

                if (parsed.isEmpty) {
                  if (!mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('CSV 內容無法解析到有效資料')),
                  );
                  return;
                }

                _addMany(parsed);
                await _saveAll();
                if (!mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('CSV 匯入完成：${parsed.length} 筆')),
                );
              } catch (e) {
                if (!mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('匯入失敗：$e')),
                );
              }
            },
          ),
          // 推薦
          IconButton(
            tooltip: '推薦號碼',
            icon: const Icon(Icons.auto_awesome),
            onPressed: () {
              showDialog(
                context: context,
                builder: (_) => _RecommendDialog(
                  issues: issues,
                  freq: freq,
                  superFreq: superFreq,
                  sampleSize: sampleSize,
                ),
              );
            },
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final d = await showDialog<Draw>(
            context: context,
            builder: (_) => const _QuickAddDialog(),
          );
          if (d == null) return;
          _addOne(d);
          await _saveAll();
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('已新增 1 筆')),
          );
        },
        label: const Text('新增'),
        icon: const Icon(Icons.add),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 上方資訊 + 超級獎號 Top 晶片列（可水平捲動）
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 12,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('視窗：'),
                        const SizedBox(width: 6),
                        DropdownButton<int>(
                          value: sampleSize,
                          items: const [50, 100, 200, 500]
                              .map((e) => DropdownMenuItem(
                                  value: e, child: Text('近 $e 期')))
                              .toList(),
                          onChanged: (v) => setState(() => sampleSize = v!),
                        ),
                      ],
                    ),
                    Text(
                      '樣本：$issues 期（理論單號約 25%）',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    const Text('超級獎號 Top：', style: TextStyle(fontSize: 12)),
                    const SizedBox(width: 6),
                    Expanded(
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(children: _buildSuperChips(superFreq)),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 4),
          // 80 顆方塊
          Expanded(
            child: GridView.count(
              padding: const EdgeInsets.all(8),
              crossAxisCount: 5, // 小螢幕比較易讀；平板可調 8
              childAspectRatio: 1.2,
              children: [
                for (int i = 1; i <= 80; i++)
                  Builder(builder: (_) {
                    final cnt = freq[i] ?? 0;
                    final p = probs[i];
                    final t = (maxP - minP) > 1e-9 ? (p - minP) / (maxP - minP) : 0.5;
                    final color =
                        Color.lerp(Colors.indigo.shade100, Colors.red.shade400, t)!;
                    final superCnt = superFreq[i] ?? 0;
                    return Card(
                      color: color.withOpacity(0.85),
                      child: Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('$i',
                                style: const TextStyle(
                                    fontSize: 16, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 2),
                            Text('${_pct(cnt, issues)}',
                                style: const TextStyle(fontSize: 12)),
                            Text('(${cnt}次)',
                                style: const TextStyle(fontSize: 11)),
                            if (superCnt > 0)
                              Padding(
                                padding: const EdgeInsets.only(top: 2),
                                child: Text('★$superCnt 次',
                                    style: const TextStyle(
                                        fontSize: 11, color: Colors.black87)),
                              ),
                          ],
                        ),
                      ),
                    );
                  }),
              ],
            ),
          ),
          // 長條圖
          SizedBox(
            height: 220,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              child: BarChart(
                BarChartData(
                  maxY: (issues == 0) ? 1.0 : null,
                  barTouchData: BarTouchData(enabled: false),
                  titlesData: FlTitlesData(
                    leftTitles: const AxisTitles(
                      sideTitles: SideTitles(showTitles: true, reservedSize: 32),
                    ),
                    bottomTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        reservedSize: 18,
                        getTitlesWidget: (v, meta) {
                          final i = v.toInt();
                          return i % 5 == 0 ? Text('$i', style: const TextStyle(fontSize: 10)) : const SizedBox.shrink();
                        },
                      ),
                    ),
                    topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                  ),
                  gridData: const FlGridData(show: true),
                  barGroups: [
                    for (int i = 1; i <= 80; i++)
                      BarChartGroupData(
                        x: i,
                        barRods: [
                          BarChartRodData(
                            toY: probs[i].isFinite ? probs[i] : 0.0,
                            width: 6,
                          )
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _buildSuperChips(Map<int, int> superFreq) {
    final entries = superFreq.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final top = entries.take(10);
    return [
      for (final e in top)
        Padding(
          padding: const EdgeInsets.only(right: 6),
          child: Chip(
            visualDensity: VisualDensity.compact,
            avatar: const Icon(Icons.star, size: 14, color: Colors.amber),
            label: Text('${e.key}（${e.value} 次）', style: const TextStyle(fontSize: 12)),
          ),
        )
    ];
  }
}

// ========== Dialogs ==========

/// 貼上匯入：每行 20 顆，最後一顆當超級獎號（若沒填也會用第 20 顆）
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
      title: const Text('貼上歷史開獎（每行 20 顆；最後一顆為超級獎號）'),
      content: SizedBox(
        width: 520,
        child: TextField(
          controller: _controller,
          maxLines: 12,
          decoration: const InputDecoration(
            hintText:
                '每行 20 個 1..80 的數字，空白/逗號皆可。\n例如：\n1 2 3 ... 20\n3,6,9,12,...,60',
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            final lines = const LineSplitter().convert(_controller.text);
            final out = <Draw>[];
            for (final line in lines) {
              final toks = line
                  .replaceAll(RegExp(r'[^\d,\s]'), ' ')
                  .split(RegExp(r'[\s,]+'))
                ..removeWhere((t) => t.isEmpty);
              final nums = <int>[];
              for (final t in toks) {
                final v = int.tryParse(t);
                if (v != null && v >= 1 && v <= 80) nums.add(v);
                if (nums.length >= 21) break; // 最多抓 21 顆（含超級）
              }
              if (nums.length < 20) continue;
              final balls = nums.take(20).toSet().toList()..sort();
              if (balls.length != 20) continue;
              final superBall = (nums.length >= 21) ? nums[20] : balls.last;
              out.add(Draw(balls: balls, superBall: superBall));
            }
            Navigator.pop(context, out);
          },
          child: const Text('匯入'),
        ),
      ],
    );
  }
}

/// 快速新增：必須先選滿 20 顆，再從這 20 顆中挑一顆作為超級獎號
class _QuickAddDialog extends StatefulWidget {
  const _QuickAddDialog();
  @override
  State<_QuickAddDialog> createState() => _QuickAddDialogState();
}

class _QuickAddDialogState extends State<_QuickAddDialog> {
  final sel = <int>{};
  int? superBall;

  @override
  Widget build(BuildContext context) {
    final canPickSuper = sel.length == 20;
    return AlertDialog(
      title: const Text('快速新增（20 顆 + 超級獎號）'),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (int i = 1; i <= 80; i++)
                    FilterChip(
                      label: Text('$i'),
                      selected: sel.contains(i),
                      onSelected: (on) {
                        setState(() {
                          if (on) {
                            if (sel.length < 20) sel.add(i);
                          } else {
                            sel.remove(i);
                            if (superBall == i) superBall = null;
                          }
                        });
                      },
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                '已選：${sel.length}/20',
                style: const TextStyle(fontSize: 12),
              ),
              const SizedBox(height: 12),
              const Text('在下列 20 顆中選擇超級獎號：'),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: -6,
                children: [
                  for (final n in (sel.toList()..sort()))
                    ChoiceChip(
                      label: Text('$n'),
                      selected: superBall == n,
                      onSelected: canPickSuper
                          ? (on) => setState(() => superBall = on ? n : null)
                          : null,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            if (sel.length != 20 || superBall == null) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('請先選滿 20 顆，再指定 1 顆超級獎號')),
              );
              return;
            }
            final balls = sel.toList()..sort();
            Navigator.pop(context, Draw(balls: balls, superBall: superBall!));
          },
          child: const Text('確定'),
        ),
      ],
    );
  }
}

/// 推薦 Dialog：依目前視窗（近 N 期）給建議
class _RecommendDialog extends StatefulWidget {
  final int issues;
  final int sampleSize;
  final Map<int, int> freq;
  final Map<int, int> superFreq;
  const _RecommendDialog({
    required this.issues,
    required this.freq,
    required this.superFreq,
    required this.sampleSize,
  });

  @override
  State<_RecommendDialog> createState() => _RecommendDialogState();
}

class _RecommendDialogState extends State<_RecommendDialog> {
  int pickCount = 10;
  String strategy = '均衡';
  late final List<MapEntry<int, int>> hotDesc;
  late final List<MapEntry<int, int>> coldAsc;
  late final List<MapEntry<int, int>> superDesc;

  @override
  void initState() {
    super.initState();
    hotDesc = widget.freq.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    coldAsc = widget.freq.entries.toList()
      ..sort((a, b) => a.value.compareTo(b.value));
    superDesc = widget.superFreq.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
  }

  List<int> _makeSet() {
    final set = <int>{};
    if (strategy == '熱追') {
      for (final e in hotDesc) {
        if (set.length >= pickCount) break;
        set.add(e.key);
      }
    } else if (strategy == '冷追') {
      for (final e in coldAsc) {
        if (set.length >= pickCount) break;
        set.add(e.key);
      }
    } else {
      // 均衡：60% 熱 + 30% 中段 + 10% 冷
      final h = (pickCount * 0.6).round();
      final m = (pickCount * 0.3).round();
      final c = pickCount - h - m;

      for (final e in hotDesc) {
        if (set.length >= h) break;
        set.add(e.key);
      }
      final mid = hotDesc.sublist(
        (hotDesc.length / 3).floor(),
        (hotDesc.length * 2 / 3).floor(),
      );
      for (final e in mid) {
        if (set.length >= h + m) break;
        set.add(e.key);
      }
      for (final e in coldAsc) {
        if (set.length >= h + m + c) break;
        set.add(e.key);
      }
    }
    final list = set.toList()..sort();
    return list;
  }

  int? _suggestSuper() => superDesc.isEmpty ? null : superDesc.first.key;

  String _ratio(int count) {
    final issues = widget.issues == 0 ? 1 : widget.issues;
    return (count / issues * 100).toStringAsFixed(1) + '%';
    }

  @override
  Widget build(BuildContext context) {
    final hotTop10 = hotDesc.take(10).toList();
    final coldTop10 = coldAsc.take(10).toList();
    final result = _makeSet();
    final superPick = _suggestSuper();

    return AlertDialog(
      title: Text('推薦號碼（近 ${widget.sampleSize} 期）'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('策略：'),
                  const SizedBox(width: 8),
                  DropdownButton<String>(
                    value: strategy,
                    items: const ['熱追', '均衡', '冷追']
                        .map((e) => DropdownMenuItem(value: e, child: Text(e)))
                        .toList(),
                    onChanged: (v) => setState(() => strategy = v ?? '均衡'),
                  ),
                  const SizedBox(width: 16),
                  const Text('候選顆數：'),
                  const SizedBox(width: 8),
                  DropdownButton<int>(
                    value: pickCount,
                    items: const [8, 10, 12, 15]
                        .map((e) => DropdownMenuItem(value: e, child: Text('$e')))
                        .toList(),
                    onChanged: (v) => setState(() => pickCount = v ?? 10),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text('建議關注（$strategy）：${result.join(', ')}'),
              const SizedBox(height: 4),
              Text('建議超級獎號：${superPick ?? "—"}'),
              const Divider(height: 18),
              const Text('近期熱號 Top10'),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: -6,
                children: [
                  for (final e in hotTop10)
                    Chip(
                      label: Text('${e.key}（${_ratio(e.value)} / ${e.value}次）'),
                      visualDensity: VisualDensity.compact,
                    ),
                ],
              ),
              const SizedBox(height: 12),
              const Text('近期冷號 Top10'),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: -6,
                children: [
                  for (final e in coldTop10)
                    Chip(
                      label: Text('${e.key}（${_ratio(e.value)} / ${e.value}次）'),
                      visualDensity: VisualDensity.compact,
                    ),
                ],
              ),
              const SizedBox(height: 12),
              const Text('超級獎號 Top5'),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: -6,
                children: [
                  for (final e in superDesc.take(5))
                    Chip(
                      avatar: const Icon(Icons.star, size: 16, color: Colors.amber),
                      label: Text('${e.key}（${e.value}次）'),
                      visualDensity: VisualDensity.compact,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('關閉')),
      ],
    );
  }
}
