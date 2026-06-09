// input: react, ./components/LoadingOverlay, ./components/SessionExpiredModal, lucide-react, react-router-dom, ./contexts/AppContext, ./router/AuthGuard, ./pages/LoginPage, ./pages/HomePage, ./pages/LearnPage, ./pages/ReviewPage, ./pages/EnglishWallPage, ./pages/AdminPage, ./components/Logo
// output: AppRouter
// pos: 系统/通用
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import React from 'react';
import { LoadingOverlay } from './components/LoadingOverlay';
import { SessionExpiredModal } from './components/SessionExpiredModal';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './contexts/AppContext';
import { PetProvider } from './contexts/PetContext';
import { AuthGuard } from './router/AuthGuard';
import { Header } from './components/Header';

const LoginPage = React.lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const HomePage = React.lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const LearnPage = React.lazy(() => import('./pages/LearnPage').then(m => ({ default: m.LearnPage })));
const ReviewPage = React.lazy(() => import('./pages/ReviewPage').then(m => ({ default: m.ReviewPage })));
const EnglishWallPage = React.lazy(() => import('./pages/EnglishWallPage').then(m => ({ default: m.EnglishWallPage })));
const LevelSelectPage = React.lazy(() => import('./pages/LevelSelectPage').then(m => ({ default: m.LevelSelectPage })));
const DebugPage = React.lazy(() => import('./pages/DebugPage').then(m => ({ default: m.DebugPage })));
const AdminPage = React.lazy(() => import('./pages/AdminPage').then(m => ({ default: m.AdminPage })));
const WrongWordsPage = React.lazy(() => import('./pages/WrongWordsPage').then(m => ({ default: m.WrongWordsPage })));

const AppRouter: React.FC = () => {
  const Shell: React.FC = () => {
    const { isLoading, token, isSessionExpired, logout } = useApp();
    const location = useLocation();
    const navigate = useNavigate();

    React.useEffect(() => {
      if (!token && location.pathname !== '/login') {
        navigate('/login', { replace: true, state: { from: location } });
      }
    }, [token, location.pathname]);

    const showHeader = location.pathname !== '/login' && location.pathname !== '/learn' && location.pathname !== '/english-wall';

    return (
      <div className="min-h-screen flex flex-col font-sans text-gray-900 bg-transparent">
        {showHeader && <Header />}
        <main className={`flex-grow flex flex-col relative z-0 ${!showHeader ? 'h-screen' : ''}`}>
          <React.Suspense fallback={<div className="min-h-[40vh]" />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/" element={<AuthGuard><HomePage /></AuthGuard>} />
              <Route path="/level-select" element={<AuthGuard><LevelSelectPage /></AuthGuard>} />
              <Route path="/learn" element={<AuthGuard><LearnPage /></AuthGuard>} />
              <Route path="/review" element={<AuthGuard><ReviewPage /></AuthGuard>} />
              <Route path="/wrong-words" element={<AuthGuard><WrongWordsPage /></AuthGuard>} />
              <Route path="/english-wall" element={<AuthGuard><EnglishWallPage /></AuthGuard>} />
              <Route path="/debug" element={<AuthGuard><DebugPage /></AuthGuard>} />
              <Route path="/admin" element={<AuthGuard><AdminPage /></AuthGuard>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </React.Suspense>
        </main>
        {showHeader && (
          <footer className="py-6 mt-auto">
            <div className="max-w-5xl mx-auto px-6 text-center text-xs text-gray-400 font-medium">
              <p>© {new Date().getFullYear()} LinguaCraft AI. Designed with <span className="text-red-400">❤</span> for language learners <a href="/debug" className="opacity-0 hover:opacity-100 transition-opacity ml-2">π</a></p>
            </div>
          </footer>
        )}
        <LoadingOverlay visible={isLoading} />
        <SessionExpiredModal
          visible={isSessionExpired}
          onLogin={async () => {
            await logout();
            navigate('/login');
          }}
        />
      </div>
    );
  };
  return (
    <BrowserRouter>
      <AppProvider>
        <PetProvider>
          <Shell />
        </PetProvider>
      </AppProvider>
    </BrowserRouter>
  );
};

export default AppRouter;
