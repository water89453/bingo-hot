import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:path_provider/path_provider.dart';

/// 單筆紀錄結構：20 顆一般號碼 + 1 顆超級獎號
class Draw {
  final List<int> balls;
  final int superBall;

  Draw({required this.balls, required this.superBall});

  Map<String, dynamic> toJson() => {
        'balls': balls,
        'super': superBall,
      };

  static Draw fromJson(Map<String, dynamic> j) =>
      Draw(balls: List<int>.from(j['balls']), superBall: j['super']);
}

class StatsApp extends StatelessWidget {
  const StatsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Bingo 歷史熱度',
      theme: ThemeData(primarySwatch: Colors.blue),
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
  int sampleSize = 200;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<File> get _localFile async {
    final dir = await getApplicationDocumentsDirectory();
    return File('${dir.path}/draws.json');
  }

  Future<void> _load() async {
    try {
      final file = await _localFile;
      if (await file.exists()) {
        final content = await file.readAsString();
        final List<dynamic> data = jsonDecode(content);
        setState(() {
          draws = data.map((e) => Draw.fromJson(e)).toList();
        });
      }
    } catch (_) {}
  }

  Future<void> _save() async {
    final file = await _localFile;
    await file.writeAsString(jsonEncode(draws.map((e) => e.toJson()).toList()));
  }

  double safePercent(int count, int total) {
    if (total <= 0) return 0.0;
    final v = (count / total * 100);
    return v.isFinite ? v.clamp(0, 100) : 0.0;
  }

  double safeRatio(int count, int total) {
    if (total <= 0) return 0.0;
    final v = (count / total);
    return v.isFinite ? v.clamp(0.0, 1.0) : 0.0;
  }

  Map<int, int> _countFreq() {
    final freq = <int, int>{};
    final recent = draws.take(sampleSize).toList();
    for (var d in recent) {
      for (var n in d.balls) {
        freq[n] = (freq[n] ?? 0) + 1;
      }
    }
    return freq;
  }

  Map<int, int> _countSuperFreq() {
    final freq = <int, int>{};
    final recent = draws.take(sampleSize).toList();
    for (var d in recent) {
      freq[d.superBall] = (freq[d.superBall] ?? 0) + 1;
    }
    return freq;
  }

  void _addDraw(Draw draw) {
    setState(() {
      draws.insert(0, draw);
    });
    _save();
  }

  @override
  Widget build(BuildContext context) {
    final freq = _countFreq();
    final superFreq = _countSuperFreq();
    final totalBalls = draws.take(sampleSize).length * 20;
    final totalSuper = draws.take(sampleSize).length;

    final probs = List<double>.generate(
        81, (i) => i == 0 ? 0.0 : safeRatio(freq[i] ?? 0, totalBalls));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Bingo 歷史熱度（近 N 期）'),
        actions: [
          IconButton(
            tooltip: '批次貼上匯入',
            icon: const Icon(Icons.file_upload),
            onPressed: () async {
              final rows = await showDialog<List<Draw>>(
                context: context,
                builder: (_) => const _PasteDialog(),
              );
              if (rows != null && rows.isNotEmpty) {
                int ok = 0;
                for (final r in rows) {
                  _addDraw(r);
                  ok++;
                }
                if (!mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('匯入完成：成功 $ok 筆')),
                );
              }
            },
          ),
        ],
      ),
      body: Column(
        children: [
          DropdownButton<int>(
            value: sampleSize,
            items: const [50, 100, 200, 500]
                .map((e) => DropdownMenuItem(value: e, child: Text('近 $e 期')))
                .toList(),
            onChanged: (v) => setState(() => sampleSize = v ?? 200),
          ),
          Expanded(
            child: GridView.count(
              crossAxisCount: 8,
              children: [
                for (var i = 1; i <= 80; i++)
                  Card(
                    color: Colors.blue.shade100
                        .withOpacity(probs[i] * 3), // 簡單漸層
                    child: Center(
                      child: Text(
                        '$i\n${safePercent(freq[i] ?? 0, totalBalls).toStringAsFixed(1)}%',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  )
              ],
            ),
          ),
          const Divider(),
          const Text('超級獎號統計（Top5）'),
          Wrap(
            spacing: 12,
            children: (superFreq.keys.toList()
                  ..sort((a, b) => (superFreq[b] ?? 0) - (superFreq[a] ?? 0)))
                .take(5)
                .map((n) => Chip(
                      label: Text(
                          '$n (${safePercent(superFreq[n]!, totalSuper).toStringAsFixed(1)}%)'),
                    ))
                .toList(),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () async {
          final draw = await showDialog<Draw>(
            context: context,
            builder: (_) => const _AddDrawDialog(),
          );
          if (draw != null) _addDraw(draw);
        },
        child: const Icon(Icons.add),
      ),
    );
  }
}

/// 單筆新增對話框
class _AddDrawDialog extends StatefulWidget {
  const _AddDrawDialog();

  @override
  State<_AddDrawDialog> createState() => _AddDrawDialogState();
}

class _AddDrawDialogState extends State<_AddDrawDialog> {
  final controller = TextEditingController();

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新增一筆開獎號碼（20 顆 + 超級獎號）'),
      content: TextField(
        controller: controller,
        decoration: const InputDecoration(
          hintText: '輸入 20 或 21 個號碼，支援逗號、空白或換行分隔\n'
              '20 顆 → 第 20 顆為超級獎號\n'
              '21 顆 → 前 20 顆一般號，第 21 顆為超級獎號',
        ),
        maxLines: 6,
      ),
      actions: [
        TextButton(
          onPressed: () {
            final toks = controller.text
                .replaceAll(RegExp(r'[^0-9,\s]'), ' ')
                .split(RegExp(r'[\s,]+')) // ✅ 空格、逗號、換行分隔
              ..removeWhere((t) => t.isEmpty);

            final nums = <int>[];
            for (final t in toks) {
              final v = int.tryParse(t);
              if (v != null && v >= 1 && v <= 80) nums.add(v);
            }

            if (nums.length < 20) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('至少需要 20 顆號碼')),
              );
              return;
            }

            List<int> balls;
            int superBall;

            if (nums.length == 20) {
              balls = nums.toList();
              superBall = balls.last;
            } else {
              balls = nums.take(20).toList();
              superBall = nums[20];
            }

            if (balls.toSet().length != 20) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('前 20 顆不可重複')),
              );
              return;
            }

            Navigator.pop(context, Draw(balls: balls, superBall: superBall));
          },
          child: const Text('確定'),
        ),
      ],
    );
  }
}

/// 批次匯入對話框
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
      title: const Text('批次貼上歷史開獎'),
      content: SizedBox(
        width: 520,
        child: TextField(
          controller: _controller,
          maxLines: 12,
          decoration: const InputDecoration(
            hintText: '每行 20 或 21 個號碼（支援空格/逗號/換行分隔）',
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
                  .replaceAll(RegExp(r'[^0-9,\s]'), ' ')
                  .split(RegExp(r'[\s,]+'))
                ..removeWhere((t) => t.isEmpty);

              final nums = <int>[];
              for (final t in toks) {
                final v = int.tryParse(t);
                if (v != null && v >= 1 && v <= 80) nums.add(v);
              }

              if (nums.length >= 20) {
                List<int> balls;
                int superBall;

                if (nums.length == 20) {
                  balls = nums.toList();
                  superBall = balls.last;
                } else {
                  balls = nums.take(20).toList();
                  superBall = nums[20];
                }

                if (balls.toSet().length == 20) {
                  out.add(Draw(balls: balls, superBall: superBall));
                }
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

void main() => runApp(const StatsApp());
