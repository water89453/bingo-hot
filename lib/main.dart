import 'dart:async';
import 'dart:convert';

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

void main() => runApp(const StatsApp());

const kRemoteJsonUrl =
    'https://water89453.github.io/bingo-hot/data/draws.json'; // 你的 Pages 路徑
const _cacheKeyData = 'remote_draws_v1';
const _cacheKeyTime = 'remote_draws_time_v1';

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
  final String period;
  final String date; // 可能是空字串
  final List<int> balls; // 20 顆（1..80，不重複、排序）
  final int superBall; // 1..80

  const Draw({
    required this.period,
    required this.date,
    required this.balls,
    required this.superBall,
  });

  factory Draw.fromJson(Map<String, dynamic> json) {
    final rawBalls = (json['balls'] as List).map((e) => int.tryParse('$e'))
        .whereType<int>()
        .toList();
    final set = rawBalls.where((v) => v >= 1 && v <= 80).toSet();
    final balls = set.toList()..sort();
    final sup = int.tryParse('${json['super']}') ?? (balls.isNotEmpty ? balls.last : 0);
    return Draw(
      period: '${json['period'] ?? ''}',
      date: '${json['date'] ?? ''}',
      balls: balls,
      superBall: sup.clamp(1, 80),
    );
  }

  Map<String, dynamic> toJson() => {
        'period': period,
        'date': date,
        'balls': balls,
        'super': superBall,
      };
}

class StatsHome extends StatefulWidget {
  const StatsHome({super.key});
  @override
  State<StatsHome> createState() => _StatsHomeState();
}

class _StatsHomeState extends State<StatsHome> {
  List<Draw> _draws = []; // 新的在最前（index 0）
  int sampleSize = 100;

  bool _loading = false;
  String? _error;
  DateTime? _lastSync;

  Timer? _autoTimer; // 可選：定時重新抓

  // ------------------ init / dispose ------------------

  @override
  void initState() {
    super.initState();
    _loadCache().then((_) => _fetchRemote(showSnackbar: false));
    // 如果想要定時自動更新（例如每 2 分鐘檢查一次）
    _autoTimer = Timer.periodic(const Duration(minutes: 2), (_) {
      _fetchRemote(showSnackbar: false);
    });
  }

  @override
  void dispose() {
    _autoTimer?.cancel();
    super.dispose();
  }

  // ------------------ Cache ------------------

  Future<void> _loadCache() async {
    try {
      final sp = await SharedPreferences.getInstance();
      final raw = sp.getString(_cacheKeyData);
      final ts = sp.getInt(_cacheKeyTime);
      if (raw != null) {
        final list = (jsonDecode(raw) as List)
            .map((e) => Draw.fromJson(Map<String, dynamic>.from(e)))
            .toList();
        setState(() {
          _draws = list;
          _lastSync = ts != null ? DateTime.fromMillisecondsSinceEpoch(ts) : null;
        });
      }
    } catch (_) {}
  }

  Future<void> _saveCache(List<Draw> draws) async {
    try {
      final sp = await SharedPreferences.getInstance();
      await sp.setString(
          _cacheKeyData, jsonEncode(draws.map((e) => e.toJson()).toList()));
      await sp.setInt(_cacheKeyTime, DateTime.now().millisecondsSinceEpoch);
    } catch (_) {}
  }

  // ------------------ Network ------------------

  Future<void> _fetchRemote({bool showSnackbar = true}) async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      // 加上 cache buster，避免瀏覽器快取
      final uri = Uri.parse('$kRemoteJsonUrl?t=${DateTime.now().millisecondsSinceEpoch}');
      final resp = await http.get(uri).timeout(const Duration(seconds: 15));
      if (resp.statusCode != 200) {
        throw Exception('HTTP ${resp.statusCode}');
      }
      final body = resp.body.trim();
      final list = (jsonDecode(body) as List)
          .map((e) => Draw.fromJson(Map<String, dynamic>.from(e)))
          .toList();

      // 依照期別排序（如果遠端已經是新到舊可省略）
      list.sort((a, b) => b.period.compareTo(a.period));

      setState(() {
        _draws = list;
        _lastSync = DateTime.now();
      });
      await _saveCache(list);

      if (showSnackbar && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('已更新：${list.length} 期')),
        );
      }
    } catch (e) {
      // 失敗時保留快取
      setState(() => _error = '更新失敗：$e');
      if (showSnackbar && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('更新失敗，使用快取中：$e')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // ------------------ 統計 ------------------

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

  double _safeRatio(int count, int total) {
    if (total <= 0) return 0.0;
    final v = count / total;
    return v.isFinite ? v.clamp(0.0, 1.0) : 0.0;
  }

  String _pct(int cnt, int totalIssues) {
    final p = _safeRatio(cnt, totalIssues) * 100.0;
    return '${p.toStringAsFixed(1)}%';
  }

  // ------------------ UI ------------------

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
          if (_lastSync != null)
            Center(
              child: Padding(
                padding: const EdgeInsets.only(right: 12),
                child: Text(
                  '更新：${_fmtTime(_lastSync!)}',
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ),
          IconButton(
            tooltip: '重新整理',
            icon: _loading
                ? const SizedBox(
                    width: 20, height: 20, child: CircularProgressIndicator())
                : const Icon(Icons.refresh),
            onPressed: _loading ? null : () => _fetchRemote(),
          ),
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
                          onChanged: (v) => setState(() => sampleSize = v ?? 100),
                        ),
                      ],
                    ),
                    Text(
                      '樣本：$issues 期（理論單號約 25%）',
                      style: const TextStyle(fontSize: 12),
                    ),
                    if (_error != null)
                      Text('$_error', style: const TextStyle(fontSize: 12, color: Colors.red)),
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
              crossAxisCount: 5, // 手機較易讀；平板可調 8
              childAspectRatio: 1.2,
              children: [
                for (int i = 1; i <= 80; i++)
                  Builder(builder: (_) {
                    final cnt = freq[i] ?? 0;
                    final p = probs[i];
                    final t =
                        (maxP - minP) > 1e-9 ? (p - minP) / (maxP - minP) : 0.5;
                    final color = Color.lerp(
                        Colors.indigo.shade100, Colors.red.shade400, t)!;
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
                          return i % 5 == 0
                              ? Text('$i', style: const TextStyle(fontSize: 10))
                              : const SizedBox.shrink();
                        },
                      ),
                    ),
                    topTitles:
                        const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    rightTitles:
                        const AxisTitles(sideTitles: SideTitles(showTitles: false)),
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
            label:
                Text('${e.key}（${e.value} 次）', style: const TextStyle(fontSize: 12)),
          ),
        )
    ];
  }

  String _fmtTime(DateTime t) {
    String two(int x) => x.toString().padLeft(2, '0');
    return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
  }
}

// ========== 推薦 Dialog ==========

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
