// input: react, react-router-dom, ../services/geminiService, ../contexts/AppContext, ../components/Header, ../components/LearningSession, ../components/SessionSummary, ../types
// output: WrongWordsPage(错题本 + 重练入口)
// pos: 前端/页面层
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWrongWords, practiceWrongWords, WrongWordItem } from '../services/geminiService';
import { EducationLevel, Question } from '../types';
import { ArrowLeft, BookOpen, Filter, AlertCircle, Volume2, Play, RefreshCw, Target, CheckCircle2 } from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { LearningSession } from '../components/LearningSession';
import { SessionSummary } from '../components/SessionSummary';

const LEVEL_LABEL: Record<string, string> = {
  Primary: '小学', Middle: '初中', High: '高中',
  CET4: '四级', CET6: '六级', University: '大学', Professional: '雅思托福'
}

const LEVEL_FULL: Record<string, EducationLevel> = {
  Primary: EducationLevel.PRIMARY,
  Middle: EducationLevel.MIDDLE,
  High: EducationLevel.HIGH,
  University: EducationLevel.UNIVERSITY,
  Professional: EducationLevel.PROFESSIONAL
}

export const WrongWordsPage: React.FC = () => {
  const navigate = useNavigate();
  const { level: contextLevel, selectedTextbook } = useApp();
  const [level, setLevel] = useState<string>('Primary');
  const [textbook, setTextbook] = useState<string>(selectedTextbook || '');
  const [items, setItems] = useState<WrongWordItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState(0);

  // 错题重练 session state
  const [sessionQueue, setSessionQueue] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [sessionProgressed, setSessionProgressed] = useState<{ word: string, stage: 'new' | 'familiar' | 'mastered' }[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  const [practiceLoading, setPracticeLoading] = useState(false);

  useEffect(() => {
    // 从 context 推断默认 level
    if (contextLevel) {
      const map: Record<string, string> = {
        [EducationLevel.PRIMARY]: 'Primary',
        [EducationLevel.MIDDLE]: 'Middle',
        [EducationLevel.HIGH]: 'High',
        [EducationLevel.UNIVERSITY]: 'University',
        [EducationLevel.PROFESSIONAL]: 'Professional'
      }
      setLevel(map[contextLevel] || 'Primary')
    }
  }, [contextLevel])

  useEffect(() => {
    loadWrongWords();
  }, [level, textbook]);

  const loadWrongWords = async () => {
    setLoading(true);
    try {
      const data = await fetchWrongWords(level, textbook || undefined);
      setItems(data.items);
      setTotalCount(data.count);
    } catch (e) {
      console.error('Failed to load wrong words:', e);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const startPractice = async () => {
    if (items.length === 0) return;
    setPracticeLoading(true);
    try {
      const questions = await practiceWrongWords(level, textbook || undefined);
      if (questions.length === 0) {
        alert('没有可练的错题');
        return;
      }
      setSessionQueue(questions);
      setCurrentIndex(0);
      setSessionProgressed([]);
      setShowSummary(false);
    } catch (e) {
      console.error('Failed to start practice:', e);
      alert('开始重练失败,请重试');
    } finally {
      setPracticeLoading(false);
    }
  };

  // 重练 session 推进
  const handleQuestionSuccess = (q: Question) => {
    setSessionProgressed(prev => [...prev, { word: q.word.word, stage: 'familiar' }]);
    moveNext();
  };
  const handleQuestionFailure = (q: Question) => {
    setSessionProgressed(prev => [...prev, { word: q.word.word, stage: 'new' }]);
    moveNext();
  };
  const moveNext = () => {
    const next = currentIndex + 1;
    if (next >= sessionQueue.length) {
      setShowSummary(true);
    } else {
      setCurrentIndex(next);
    }
  };
  const exitPractice = () => {
    setSessionQueue([]);
    setCurrentIndex(0);
    setShowSummary(false);
    setSessionProgressed([]);
    loadWrongWords(); // 重练完刷一下列表
  };

  // 暂未上线四级 / 六级 / 雅思托福词库,先隐藏对应筛选
  const levelOptions = [
    { value: 'Primary', label: '小学' },
    { value: 'Middle', label: '初中' },
    { value: 'High', label: '高中' },
  ];

  const playAudio = (word: string) => {
    const audio = new Audio(`/api/learning/audio?word=${encodeURIComponent(word)}`)
    audio.play().catch(() => {
      // 降级到 SpeechSynthesis
      const u = new SpeechSynthesisUtterance(word)
      u.lang = 'en-US'
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
    })
  }

  // ============= 重练 session 模式渲染 =============
  if (sessionQueue.length > 0 && !showSummary) {
    return (
      <LearningSession
        question={sessionQueue[currentIndex]}
        currentIndex={currentIndex}
        totalCount={sessionQueue.length}
        onSuccess={handleQuestionSuccess}
        onFailure={handleQuestionFailure}
        onSkip={moveNext}
        onExit={exitPractice}
        onReady={() => {}}
      />
    )
  }

  if (showSummary) {
    return (
      <SessionSummary
        items={sessionProgressed.map(i => ({ word: i.word, stage: i.stage as 'new' | 'familiar' | 'mastered' }))}
        count={sessionProgressed.length}
        streak={0}
        streakDelta={0}
        onBackHome={exitPractice}
      />
    )
  }

  // ============= 错题本列表 =============
  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <div className="bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors">
              <ArrowLeft size={24} />
            </button>
            <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Target className="text-rose-500" size={22} />
              错题本
            </h1>
            <button onClick={loadWrongWords} className="p-2 -mr-2 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors" disabled={loading}>
              <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {levelOptions.map(l => (
              <button
                key={l.value}
                onClick={() => { setLevel(l.value); setTextbook(''); }}
                className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${level === l.value
                  ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20'
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
        {/* 顶部统计 + 重练 CTA */}
        <div className="bg-white rounded-2xl p-5 mb-4 border border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm text-gray-500">答错未掌握的单词</p>
              <p className="text-3xl font-bold text-rose-500 mt-1">{totalCount}</p>
            </div>
            <button
              onClick={startPractice}
              disabled={items.length === 0 || practiceLoading}
              className="px-5 py-3 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-600 text-white font-bold shadow-lg shadow-rose-500/25 hover:shadow-rose-500/40 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {practiceLoading ? (
                <>
                  <RefreshCw size={18} className="animate-spin" />
                  加载中...
                </>
              ) : (
                <>
                  <Play size={18} fill="currentColor" />
                  错题重练
                </>
              )}
            </button>
          </div>
          {items.length > 0 && (
            <p className="text-xs text-gray-400 mt-2">
              每次最多练 5 题,答错的会回到错题本,答对 1 题会让 stage 升 1 级(stage 升到 3 自动从错题本毕业)
            </p>
          )}
        </div>

        {/* 列表 */}
        {loading ? (
          <div className="text-center py-12 text-gray-400">加载中...</div>
        ) : items.length === 0 ? (
          <div className="bg-white rounded-2xl p-10 border border-gray-100 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-50 flex items-center justify-center">
              <CheckCircle2 className="text-green-500" size={32} />
            </div>
            <h3 className="text-lg font-bold text-gray-800 mb-2">错题本是空的 🎉</h3>
            <p className="text-sm text-gray-500 mb-6">
              {LEVEL_LABEL[level]}学段下没有需要重练的单词。<br />
              继续学习,答错的词会自动加入这里。
            </p>
            <button
              onClick={() => navigate('/learn')}
              className="px-5 py-2.5 rounded-xl bg-brand-500 text-white font-bold text-sm hover:bg-brand-600 transition-colors"
            >
              去学习
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item, idx) => (
              <div
                key={item.wordId}
                className="bg-white rounded-xl p-4 border border-gray-100 flex items-center gap-3 hover:border-rose-200 transition-colors"
              >
                {/* 排名/严重度 */}
                <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm ${
                  item.wrongCount >= 3
                    ? 'bg-rose-50 text-rose-600'
                    : item.wrongCount >= 2
                    ? 'bg-orange-50 text-orange-600'
                    : 'bg-amber-50 text-amber-600'
                }`}>
                  {item.wrongCount}×
                </div>

                {/* 单词信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold text-gray-900">{item.word}</h3>
                    {item.partOfSpeech && (
                      <span className="text-xs text-gray-400 italic">{item.partOfSpeech}</span>
                    )}
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                      {item.cefr}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 truncate">{item.definition}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Stage {item.stage} · 下次复习 {new Date(item.nextReviewAt).toLocaleDateString('zh-CN')}
                  </p>
                </div>

                {/* 喇叭按钮 */}
                <button
                  onClick={() => playAudio(item.word)}
                  className="shrink-0 p-2.5 rounded-xl text-gray-400 hover:text-brand-500 hover:bg-brand-50 transition-colors"
                  title="发音"
                >
                  <Volume2 size={18} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
