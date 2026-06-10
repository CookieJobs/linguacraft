import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchProgress } from '../services/geminiService';
import { EducationLevel, ProgressStats, MasteredItem } from '../types';
import { ArrowLeft, BookOpen, Filter, CheckCircle2, BrickWall, ChevronRight } from 'lucide-react';
import { ReviewList } from '../components/ReviewList';
import { WordProgressBar } from '../components/WordProgressBar';

import { useApp } from '../contexts/AppContext';

export const ReviewPage: React.FC = () => {
  const { level: contextLevel, selectedTextbook } = useApp();
  const navigate = useNavigate();
  const [level, setLevel] = useState<EducationLevel | string>(contextLevel || 'Primary');
  const [textbook, setTextbook] = useState<string>(selectedTextbook || '');
  const [stats, setStats] = useState<ProgressStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadProgress();
  }, [level, textbook]);

  const loadProgress = async () => {
    setLoading(true);
    try {
      const data = await fetchProgress(level, textbook || undefined);
      setStats(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // 暂未上线四级 / 六级 / 雅思托福词库,先隐藏对应筛选
  const levelOptions = [
    { value: 'Primary', label: '小学' },
    { value: 'Middle', label: '初中' },
    { value: 'High', label: '高中' },
  ];

  // Convert stats list to MasteredItem format for ReviewList
  const reviewItems: MasteredItem[] = stats?.list.filter(w => w.mastered).map(w => ({
    word: w.word,
    definition: w.definition,
    partOfSpeech: '', // Backend doesn't return POS in progress list yet, maybe update service? Or just optional
    example: '',
    userSentence: '已掌握',
    masteredAt: w.lastMastered || new Date().toISOString(),
    sourceLevel: level as EducationLevel
  })) || [];

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <div className="bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors">
              <ArrowLeft size={24} />
            </button>
            <h1 className="text-xl font-bold text-gray-900">学习进度</h1>
            <div className="w-8" />
          </div>

          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {levelOptions.map(l => (
              <button
                key={l.value}
                onClick={() => { setLevel(l.value); setTextbook(''); }}
                className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${level === l.value
                  ? 'bg-brand-500 text-white shadow-md shadow-brand-500/20'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Progress Card */}
        <div className="bg-gradient-to-br from-brand-600 to-duo-blue-dark rounded-3xl p-6 text-white shadow-xl shadow-brand-900/10 mb-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-8 opacity-10">
            <BookOpen size={120} />
          </div>
          <div className="relative z-10">
            <div className="text-brand-100 font-medium mb-1 flex items-center gap-2">
              <Filter size={14} />
              {levelOptions.find(l => l.value === level)?.label} {textbook ? `• ${textbook}` : ''}
            </div>
            <div className="flex items-baseline gap-2 mb-4">
              <span className="text-4xl font-bold">{stats?.masteredCount || 0}</span>
              <span className="text-brand-200">/ {stats?.totalCount || 0} 词</span>
            </div>
            <div className="h-3 bg-black/20 rounded-full overflow-hidden backdrop-blur-sm">
              <div
                className="h-full bg-white/90 rounded-full transition-all duration-1000 ease-out"
                style={{ width: `${stats?.totalCount ? Math.min(100, (stats.masteredCount / stats.totalCount) * 100) : 0}%` }}
              />
            </div>
          </div>
        </div>

        {/* English Wall Entry */}
        <div 
          onClick={() => navigate('/english-wall')}
          className="bg-white rounded-3xl p-4 mb-8 shadow-sm border border-gray-100 flex items-center justify-between cursor-pointer hover:shadow-md hover:border-amber-200 transition-all group"
        >
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-500 group-hover:scale-110 group-hover:bg-amber-100 transition-all">
              <BrickWall size={28} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-0.5">英语墙</h3>
              <p className="text-sm text-gray-500">3D 可视化你的单词掌握进度</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xl font-black text-amber-500">
                {stats?.totalCount ? Math.round((stats.masteredCount / stats.totalCount) * 100) : 0}%
              </div>
              <div className="text-xs text-gray-400 font-medium">构建进度</div>
            </div>
            <div className="w-8 h-8 rounded-full bg-gray-50 flex items-center justify-center group-hover:bg-amber-50 transition-colors">
              <ChevronRight size={20} className="text-gray-400 group-hover:text-amber-500 transition-colors" />
            </div>
          </div>
        </div>

        {/* Word List */}
        {loading ? (
          <div className="text-center py-20 text-gray-400">加载中...</div>
        ) : (
          <div className="space-y-8">
            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                <CheckCircle2 className="text-duo-green" size={20} />
                已掌握 ({reviewItems.length})
              </h3>
              {reviewItems.length > 0 ? (
                <ReviewList items={reviewItems} />
              ) : (
                <div className="text-center py-10 bg-white rounded-2xl border border-gray-100 text-gray-400 text-sm">
                  还没有掌握本阶段的单词
                </div>
              )}
            </div>

            {/* 未掌握单词列表 - 带进度条 */}
            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2 text-gray-400">
                <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
                未掌握 ({params(stats?.totalCount || 0) - (stats?.masteredCount || 0)})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {stats?.list.filter(w => !w.mastered).slice(0, 50).map((w, i) => (
                  <div key={i} className="p-4 bg-white border border-gray-100 rounded-xl hover:border-brand-200 hover:shadow-sm transition-all">
                    <div className="flex items-start justify-between mb-2">
                      <div className="font-bold text-base text-gray-900">{w.word}</div>
                      {w.wrongCount > 3 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 font-medium">
                          易错
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mb-3 line-clamp-1">{w.definition}</div>
                    <WordProgressBar 
                      stage={w.stage ?? 0} 
                      showLabel={true}
                      height={6}
                      showNodes={false}
                    />
                  </div>
                ))}
                {(stats?.list.filter(w => !w.mastered).length || 0) > 50 && (
                  <div className="col-span-full text-center text-xs text-gray-400 py-2">
                    ... 还有 {(stats?.list.filter(w => !w.mastered).length || 0) - 50} 个单词
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function params(n: number) { return n }
