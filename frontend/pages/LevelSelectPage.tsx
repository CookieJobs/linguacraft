import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../contexts/AppContext';
import { EducationLevel } from '../types';
import { ArrowLeft, Check } from 'lucide-react';

export const LevelSelectPage: React.FC = () => {
    const { isLoading, level: currentLevel, handleLevelSelect, selectedTextbook: currentTextbook } = useApp();
    const navigate = useNavigate();

    // Local state for immediate feedback without triggering global loading
    const [tempLevel, setTempLevel] = useState<EducationLevel | null>(currentLevel);
    const [tempTextbook, setTempTextbook] = useState<string | null>(currentTextbook);

    useEffect(() => {
        if (currentLevel) setTempLevel(currentLevel);
    }, [currentLevel]);

    useEffect(() => {
        setTempTextbook(currentTextbook);
    }, [currentTextbook]);


    // 暂未上线四级 / 六级 / 雅思托福词库,先隐藏对应入口
    // (数据准备好后加回 UNIVERSITY / PROFESSIONAL 两行即可)
    const levels = [
        { id: EducationLevel.PRIMARY, label: '小学', icon: '🌱', desc: '基础词汇与日常对话' },
        { id: EducationLevel.MIDDLE, label: '初中', icon: '🚀', desc: '进阶语法与常用表达' },
        { id: EducationLevel.HIGH, label: '高中', icon: '🎓', desc: '高考重点与复杂句式' },
    ];

    return (
        <div className="pb-16 min-h-screen bg-gray-50/50">
            <main className="max-w-3xl mx-auto px-5 py-6">
                {/* Header */}
                <div className="flex items-center gap-4 mb-8">
                    <button
                        onClick={() => navigate('/')}
                        className="p-2 -ml-2 hover:bg-gray-100 rounded-xl transition-colors text-gray-600"
                    >
                        <ArrowLeft size={24} />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900">选择学习等级</h1>
                        <p className="text-sm text-gray-500 font-medium">挑选适合您的挑战级别</p>
                    </div>
                </div>

                {/* Level List */}
                <div className="grid gap-4">
                    {levels.map((l) => (
                        <div key={l.id} className="relative group">
                            <button
                                onClick={() => {
                                    setTempLevel(l.id);
                                    setTempTextbook(null);
                                }}
                                disabled={isLoading}
                                className={`
                w-full relative p-5 rounded-2xl border-2 text-left flex items-center gap-5 transition-all duration-300
                ${tempLevel === l.id
                                        ? 'bg-brand-50 border-brand-500 border-b-2 translate-y-1'
                                        : 'bg-white border-gray-200 border-b-4 hover:border-duo-blue active:border-b-2 active:translate-y-1'}
                ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
              `}
                            >
                                <div className={`
                w-14 h-14 rounded-xl flex items-center justify-center text-3xl shadow-sm transition-transform group-hover:scale-110
                ${tempLevel === l.id ? 'bg-white' : 'bg-gray-50 group-hover:bg-brand-50'}
              `}>
                                    {l.icon}
                                </div>

                                <div className="flex-1">
                                    <div className="flex items-center gap-3 mb-1">
                                        <span className={`font-bold text-lg ${tempLevel === l.id ? 'text-brand-700' : 'text-gray-900'}`}>
                                            {l.label}
                                        </span>
                                        {tempLevel === l.id && (
                                            <span className="px-2 py-0.5 rounded-full bg-brand-100/50 text-brand-600 text-xs font-bold uppercase tracking-wider">
                                                当前
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-sm text-gray-500 font-medium">{l.desc}</p>
                                </div>

                                {tempLevel === l.id && (
                                    <div className="text-brand-500 bg-white p-2 rounded-full shadow-sm">
                                        <Check size={20} strokeWidth={3} />
                                    </div>
                                )}
                            </button>
                        </div>
                    ))}
                </div>
            </main>

            {/* Bottom Confirmation Bar */}
            <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg animate-slide-up z-50">
                <div className="max-w-3xl mx-auto flex items-center justify-between">
                    <div className="text-sm text-gray-500">
                        {tempLevel && (
                            <span>
                                已选择: <span className="font-bold text-gray-900">{levels.find(l => l.id === tempLevel)?.label}</span>
                                {tempTextbook && <span className="text-gray-400"> • {tempTextbook}</span>}
                            </span>
                        )}
                    </div>
                    <button
                        onClick={async () => {
                            const hasChanges = tempLevel !== currentLevel || tempTextbook !== currentTextbook;
                            if (hasChanges && tempLevel) {
                                await handleLevelSelect(tempLevel, tempTextbook);
                            }
                            navigate('/');
                        }}
                        className="bg-brand-600 hover:bg-brand-700 text-white font-bold py-2.5 px-6 rounded-xl shadow-md hover:shadow-lg transition-all active:scale-95"
                    >
                        完成选择
                    </button>
                </div>
            </div>
        </div>
    );
};
