import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../contexts/AppContext';
import { Button } from './Button';
import { Logo } from './Logo';
import CoinBalance from './CoinBalance';
import { StreakStatus } from './StreakStatus';
import { LogOut, User, ChevronDown, BookOpen, Shield, Target } from 'lucide-react';

export const Header: React.FC = () => {
    const { token, userEmail, logout, level, isAdmin } = useApp();
    const navigate = useNavigate();

    const getLevelLabel = (l: any) => {
        switch (l) {
            case 'Primary School (小学)': return '小学'
            case 'Junior High School (初中)': return '初中'
            case 'Senior High School (高中)': return '高中'
            case 'CET4 (四级)': return '四级'
            case 'CET6 (六级)': return '六级'
            case 'University (大学/四六级)': return '四级'
            case 'Professional/Study Abroad (雅思/托福/职场)': return '六级'
            default: return null
        }
    }

    const levelLabel = getLevelLabel(level)

    return (
        <header className="sticky top-0 z-50 w-full bg-white border-b-2 border-gray-200 transition-all duration-300">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
                {/* Left: Logo */}
                <div
                    className="flex items-center gap-2 cursor-pointer transition-opacity"
                    onClick={() => navigate('/')}
                    title="返回首页"
                >
                    <Logo size="sm" />
                </div>

                {/* Right: Actions */}
                <div className="flex items-center gap-4">
                    {token ? (
                        <>
                            <div className="hidden sm:block">
                                <StreakStatus />
                            </div>

                            {/* 错题本入口 */}
                            <button
                                onClick={() => navigate('/wrong-words')}
                                className="flex items-center justify-center w-8 h-8 rounded-xl bg-gradient-to-br from-rose-50 to-rose-100 hover:from-rose-100 hover:to-rose-200 text-rose-500 hover:text-rose-600 border border-rose-200/50 hover:border-rose-200 transition-all shadow-sm group"
                                title="错题本"
                            >
                                <Target size={16} className="group-hover:scale-110 transition-transform" />
                            </button>
                            <div className="hidden sm:block">
                                <CoinBalance />
                            </div>

                            {/* Level Badge Switcher */}
                            {levelLabel && (
                                <button
                                    onClick={() => navigate('/level-select')}
                                    className="hidden sm:flex items-center gap-1.5 px-3 py-1 bg-gradient-to-br from-blue-50 to-sky-50 hover:from-blue-100 hover:to-sky-100 text-blue-700 rounded-xl border border-blue-200/50 hover:border-blue-200 transition-all group shadow-sm"
                                    title="切换学段/教材"
                                >
                                    <BookOpen size={18} className="fill-blue-500 text-blue-600 group-hover:scale-110 transition-transform" />
                                    <span className="text-base font-bold text-blue-700">{levelLabel}</span>
                                    <ChevronDown size={14} className="text-blue-400 group-hover:text-blue-600 transition-colors ml-0.5" strokeWidth={2.5} />
                                </button>
                            )}

                            {/* User Profile & Logout */}
                            <div className="flex items-center gap-3">
                                {isAdmin && (
                                    <button
                                        onClick={() => navigate('/admin')}
                                        className="flex items-center justify-center w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-50 to-purple-50 hover:from-indigo-100 hover:to-purple-100 text-indigo-600 border border-indigo-200/50 hover:border-indigo-200 transition-all shadow-sm group"
                                        title="管理后台"
                                    >
                                        <Shield size={16} className="group-hover:scale-110 transition-transform" />
                                    </button>
                                )}
                                {userEmail && (
                                    <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-gradient-to-br from-gray-50 to-slate-50 border border-gray-200/50 rounded-xl shadow-sm cursor-default">
                                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-brand-100 to-duo-blue/20 flex items-center justify-center text-brand-600 border border-brand-200/50 shadow-sm">
                                            <User size={12} strokeWidth={2.5} />
                                        </div>
                                        <span className="hidden md:inline text-sm font-bold text-gray-600">{userEmail.split('@')[0]}</span>
                                    </div>
                                )}

                                <button
                                    onClick={async () => { await logout(); navigate('/login'); }}
                                    className="flex items-center justify-center w-8 h-8 rounded-xl bg-gradient-to-br from-red-50 to-duo-red/10 hover:from-red-100 hover:to-duo-red/20 text-red-500 hover:text-red-600 border border-red-200/50 hover:border-red-200 transition-all shadow-sm group"
                                    title="退出登录"
                                >
                                    <LogOut size={16} className="group-hover:scale-110 transition-transform" />
                                </button>
                            </div>
                        </>
                    ) : (
                        <Button
                            variant="primary"
                            onClick={() => navigate('/login')}
                        >
                            登录
                        </Button>
                    )}
                </div>
            </div>
        </header>
    );
};
