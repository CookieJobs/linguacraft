import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { EducationLevel, MasteredItem, Question } from '../types';
import { getMe, logout as apiLogout, getStats, updateMe, fetchSessionQuestions, submitAnswer } from '../services/geminiService';
import { SESSION_EXPIRED_EVENT } from '../services/apiClient';

type AppContextType = {
  token: string | null;
  setToken: (t: string | null) => void;
  userEmail: string | null;
  isAdmin: boolean;
  level: EducationLevel | null;
  meLoaded: boolean;
  sessionQueue: Question[];
  currentIndex: number;
  masteredItems: MasteredItem[];
  sessionProgressed: { word: string, stage: 'new' | 'familiar' | 'mastered' }[];
  isLoading: boolean;
  streak: number;
  streakAtSessionStart: number;
  sessionProgress: number;
  loadError: { code: string; message: string } | null;
  handleLevelSelect: (selectedLevel: EducationLevel, selectedTextbook?: string | null) => Promise<void>;
  handleQuestionSuccess: (question: Question, answer: any) => Promise<void>;
  handleQuestionFailure: (question: Question, answer: any) => Promise<void>;
  handleSkip: () => void;
  moveToNext: () => void;
  resetToHome: () => void;
  exitLearning: () => void;
  showSummary: boolean;
  startNextSession: () => Promise<void>;
  dismissSummary: () => void;
  logout: () => Promise<void>;
  isSessionExpired: boolean;
  selectedTextbook: string | null;
  handleTextbookSelect: (t: string | null) => void;
};

const AppContext = createContext<AppContextType | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [level, setLevel] = useState<EducationLevel | null>(EducationLevel.PRIMARY);
  const [selectedTextbook, setSelectedTextbook] = useState<string | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [sessionQueue, setSessionQueue] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [masteredItems, setMasteredItems] = useState<MasteredItem[]>(() => {
    const saved = localStorage.getItem('linguaCraft_mastered');
    return saved ? JSON.parse(saved) : [];
  });
  const [sessionProgressed, setSessionProgressed] = useState<{ word: string, stage: 'new' | 'familiar' | 'mastered' }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem('linguaCraft_token'));
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // streak 以后端为权威源(UTC 天的连续天数),初始 0,由 useEffect 拉 getStats 覆盖
  const [streak, setStreak] = useState<number>(0);
  const [sessionProgress, setSessionProgress] = useState(0);
  const [showSummary, setShowSummary] = useState(false);
  const [streakAtSessionStart, setStreakAtSessionStart] = useState<number>(0);
  const [isSessionExpired, setIsSessionExpired] = useState(false);
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    localStorage.setItem('linguaCraft_mastered', JSON.stringify(masteredItems));
  }, [masteredItems]);

  useEffect(() => {
    const load = async () => {
      if (!token) { setUserEmail(null); setStreak(0); setIsAdmin(false); setMeLoaded(true); return; }
      try {
        const me = await getMe();
        setUserEmail(me.email);
        setIsAdmin(!!me.isAdmin);
        if (me.educationLevel) setLevel(me.educationLevel as EducationLevel);
        if (me.textbook) setSelectedTextbook(me.textbook);
        try { const s = await getStats(); setStreak(s.currentStreak || 0) } catch { }
      } catch {
        setUserEmail(null);
        setIsAdmin(false);
      }
      setMeLoaded(true)
    };
    load();
  }, [token]);

  useEffect(() => {
    const onForceLogout = () => {
      setTokenState(null);
      setLevel(null);
      setIsAdmin(false);
      setSessionQueue([]);
      setCurrentIndex(0);
      setSessionProgress(0);
      setSessionProgressed([]);
      setIsSessionExpired(false);
      setLoadError(null);
    };

    const onSessionExpired = () => {
      setIsSessionExpired(true);
    };

    window.addEventListener('force-logout', onForceLogout);
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => {
      window.removeEventListener('force-logout', onForceLogout);
      window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    };
  }, []);

  function normalizeLevel(level: EducationLevel): string {
    switch (level) {
      case EducationLevel.PRIMARY: return 'Primary'
      case EducationLevel.MIDDLE: return 'Middle'
      case EducationLevel.HIGH: return 'High'
      case EducationLevel.UNIVERSITY: return 'CET-4 (四级)'
      case EducationLevel.PROFESSIONAL: return 'CET-6 (六级)'
      default: return String(level)
    }
  }

  const startNextSession = async (overrideLevel?: EducationLevel, overrideTextbook?: string | null) => {
    setIsLoading(true)
    setLoadError(null)
    const currentLevel = overrideLevel || level || EducationLevel.PRIMARY;
    try {
      const questions = await fetchSessionQuestions(normalizeLevel(currentLevel), overrideTextbook !== undefined ? (overrideTextbook || undefined) : (selectedTextbook || undefined))
      
      setSessionQueue(questions || [])
      setCurrentIndex(0)
      setSessionProgressed([])
      setSessionProgress(0)
      setShowSummary(false)
      setStreakAtSessionStart(streak || 0)
    } catch (error) {
      setLoadError(toLoadError(error))
    }
    setIsLoading(false)
  }

  const handleLevelSelect = async (selectedLevel: EducationLevel, newTextbook?: string | null) => {
    setIsLoading(true);
    setLoadError(null);
    setLevel(selectedLevel);
    if (newTextbook !== undefined) {
      setSelectedTextbook(newTextbook);
    }
    // Persist to backend
    if (token) {
      updateMe({ 
        educationLevel: selectedLevel,
        ...(newTextbook !== undefined ? { textbook: newTextbook || '' } : {})
      }).catch(() => { });
    }
    await startNextSession(selectedLevel, newTextbook);
  };

  const handleQuestionSuccess = async (question: Question, answer: any) => {
    // Update sessionProgressed
    const stageMap: Record<string, 'new' | 'familiar' | 'mastered'> = {
      'choice': 'new',
      'quiz': 'familiar',
      'sentence': 'mastered'
    };
    const stage = stageMap[question.type] || 'new';
    setSessionProgressed(prev => {
      const exists = prev.find(p => p.word === question.word.word);
      if (exists) {
        // If it exists, update it if the new stage is "higher"
        const stagePriority = { 'new': 1, 'familiar': 2, 'mastered': 3 };
        if (stagePriority[stage] > stagePriority[exists.stage]) {
          return prev.map(p => p.word === question.word.word ? { ...p, stage } : p);
        }
        return prev;
      }
      return [...prev, { word: question.word.word, stage }];
    });

    if (question.type === 'sentence') {
        const newItem: MasteredItem = {
          ...question.word,
          userSentence: answer,
          masteredAt: new Date().toISOString(),
          sourceLevel: level || EducationLevel.PRIMARY,
        };
        setMasteredItems(prev => [newItem, ...prev]);
    }
    setSessionProgress(p => p + 1);

    // Submit to backend — 服务端反作弊,只传 selectedOptionId 或 userSentence,不信前端 isCorrect
    try {
        if (question.type === 'sentence') {
            await submitAnswer(question.wordId, undefined, answer)
        } else {
            await submitAnswer(question.wordId, answer, undefined)
        }
    } catch { }

    // streak 以后端为权威源(UTC 天的连续天数),mastery 触发后端 stats.checkin 内部 +1
    // 这里直接拉一次 stats,避免前端 localStorage 和后端 UTC 漂一天
    try {
      const s = await getStats();
      setStreak(s.currentStreak || 0);
    } catch { }
    moveToNext();
  };

  const handleQuestionFailure = async (question: Question, answer: any) => {
    // 答错：把答题记录上报后端，让 SRS 的 wrongStreak / stage 降级能跑起来
    // 不算 streak、不发金币、不写 masteredItems、不进 sessionProgressed
    // 服务端自己用 selectedOptionId 判 false,所以传过去让后端校验
    try {
      if (question.type === 'sentence') {
        await submitAnswer(question.wordId, undefined, answer);
      } else {
        await submitAnswer(question.wordId, answer, undefined);
      }
    } catch { /* 静默失败,继续走题,不阻塞 UX */ }
    moveToNext();
  };

  const handleSkip = () => { moveToNext(); };

  const moveToNext = async () => {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= sessionQueue.length) {
      setShowSummary(true);
    } else {
      setCurrentIndex(nextIndex);
    }
  };

  const resetToHome = () => {
    setSessionQueue([]);
    setCurrentIndex(0);
    setSessionProgress(0);
    setSessionProgressed([]);
    setLoadError(null);
  };

  const exitLearning = () => {
    setSessionQueue([]);
    setCurrentIndex(0);
    setSessionProgress(0);
    setSessionProgressed([]);
    setLoadError(null);
  };

  const dismissSummary = () => { setShowSummary(false) }

  const logout = async () => {
    try { await apiLogout() } catch { }
    localStorage.removeItem('linguaCraft_token');
    localStorage.removeItem('linguaCraft_refresh');
    // 兼容老用户: 删掉前端旧的 streak localStorage,以后端为唯一权威
    localStorage.removeItem('linguaCraft_streak');
    setTokenState(null);
    setLevel(null);
    setIsAdmin(false);
    setSessionQueue([]);
    setCurrentIndex(0);
    setSessionProgress(0);
    setIsSessionExpired(false);
    setLoadError(null);
  };

  const setToken = (t: string | null) => { setTokenState(t); };

  function toLoadError(error: any): { code: string; message: string } {
    const code = String(error?.code || error?.message || 'unknown')
    if (code === 'unauthorized' || code === 'TOKEN_EXPIRED' || code === '401') {
      return { code: 'TOKEN_EXPIRED', message: '登录已过期，请重新登录。' }
    }
    if (code === 'VOCAB_EMPTY') {
      return { code: 'VOCAB_EMPTY', message: '词库未初始化或正在导入，请稍后再试。' }
    }
    if (code === 'DB_NOT_READY') {
      return { code: 'DB_NOT_READY', message: '数据库未就绪，请稍后重试。' }
    }
    return { code: 'UNKNOWN', message: '加载失败，请检查后端服务或网络连接。' }
  }

  const value = useMemo<AppContextType>(() => ({
    token,
    setToken,
    userEmail,
    isAdmin,
    level,
    meLoaded,
    sessionQueue,
    currentIndex,
    masteredItems,
    sessionProgressed,
    isLoading,
    streak,
    streakAtSessionStart,
    sessionProgress,
    loadError,
    handleLevelSelect,
    handleQuestionSuccess,
    handleQuestionFailure,
    handleSkip,
    moveToNext,
    resetToHome,
    exitLearning,
    showSummary,
    startNextSession: () => startNextSession(),
    dismissSummary,
    logout,
    isSessionExpired,
    selectedTextbook,
    handleTextbookSelect: (t) => {
      setSelectedTextbook(t);
      if (token) {
        updateMe({ textbook: t || '' }).catch(() => { });
      }
    }
  }), [token, userEmail, isAdmin, level, meLoaded, sessionQueue, currentIndex, masteredItems, sessionProgressed, isLoading, streak, streakAtSessionStart, sessionProgress, showSummary, isSessionExpired, loadError, selectedTextbook]);

  return (<AppContext.Provider value={value}>{children}</AppContext.Provider>);
};

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext not found');
  return ctx;
};
