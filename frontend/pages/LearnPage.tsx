// input: react, react-router-dom, ../components/LearningSession, ../components/SessionSummary, ../contexts/AppContext
// output: LearnPage（含加载失败提示）
// pos: 前端/页面层
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LearningSession } from '../components/LearningSession';
import { SessionSummary } from '../components/SessionSummary';
import { useApp } from '../contexts/AppContext';
import { RefreshCw, LogIn, BookOpen } from 'lucide-react';

export const LearnPage: React.FC = () => {
  const { sessionQueue, currentIndex, handleQuestionSuccess, handleQuestionFailure, handleSkip, exitLearning, showSummary, sessionProgressed, startNextSession, streak, streakAtSessionStart, isLoading, loadError, logout } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (sessionQueue.length === 0) { startNextSession(); }
  }, []);

  return (
    <div className="flex-grow flex flex-col h-full animate-fade-in relative overflow-hidden">
      {sessionQueue.length > 0 && !showSummary ? (
        <LearningSession
            question={sessionQueue[currentIndex]}
            currentIndex={currentIndex}
            totalCount={sessionQueue.length}
            onSuccess={handleQuestionSuccess}
            onFailure={handleQuestionFailure}
            onSkip={handleSkip}
            onExit={() => { exitLearning(); navigate(-1); }}
            onReady={() => { }}
          />
        ) : showSummary ? (
          <SessionSummary
            items={sessionProgressed.map(i => ({ word: i.word, stage: i.stage as 'new' | 'familiar' | 'mastered' }))}
            count={sessionProgressed.length}
            streak={streak}
            streakDelta={Math.max(0, (streak || 0) - (streakAtSessionStart || 0))}
            onBackHome={() => { exitLearning(); navigate(-1); }}
          />
      ) : (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center bg-white border-2 border-gray-200 border-b-4 rounded-2xl max-w-sm w-full p-8">
            {isLoading ? (
              <div className="flex flex-col items-center">
                <div className="relative mb-5">
                  <div className="w-14 h-14 border-[3px] border-brand-100 rounded-full"></div>
                  <div className="absolute inset-0 w-14 h-14 border-[3px] border-transparent border-t-brand-500 rounded-full animate-spin"></div>
                </div>
                <p className="text-gray-500 font-medium text-sm">正在为你准备个性化学习内容...</p>
              </div>
            ) : (
              <div>
                <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-gray-100 to-gray-50 flex items-center justify-center text-gray-400">
                  <BookOpen size={26} />
                </div>
                <p className="mb-5 text-gray-600 font-medium text-sm">{loadError?.message || '加载单词失败'}</p>
                <div className="flex items-center justify-center gap-3">
                  {loadError?.code === 'TOKEN_EXPIRED' ? (
                    <button
                      onClick={async () => { await logout(); navigate('/login'); }}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold shadow-lg shadow-brand-500/25 hover:shadow-brand-500/35 transition-all active:scale-95"
                    >
                      <LogIn size={16} />
                      去登录
                    </button>
                  ) : (
                    <button
                      onClick={() => { startNextSession(); }}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold shadow-lg shadow-brand-500/25 hover:shadow-brand-500/35 transition-all active:scale-95"
                    >
                      <RefreshCw size={16} />
                      重试
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )
      }
    </div >
  );
};
