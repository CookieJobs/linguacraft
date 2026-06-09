import React, { useState, useEffect, useRef } from 'react';
import { Question, FeedbackResponse } from '../types';
import { Button } from './Button';
import { evaluateSentence } from '../services/geminiService';
import { Volume2, X, CheckCircle2, AlertCircle, CornerDownLeft } from 'lucide-react';
import { SentenceQuestion } from './SentenceQuestion';
import { MultipleChoiceQuestion } from './MultipleChoiceQuestion';
import { usePet } from '../contexts/PetContext';

interface LearningSessionProps {
   question: Question;
   currentIndex: number;
   totalCount: number;
   onSuccess: (question: Question, answer: any) => void;
   onFailure?: (question: Question, answer: any) => void;  // 答错时上报 SRS,不算 streak/奖励
   onSkip: () => void;
   onExit: () => void;
   onReady?: () => void;
}

export const LearningSession: React.FC<LearningSessionProps> = ({
   question,
   currentIndex,
   totalCount,
   onSuccess,
   onFailure,
   onSkip,
   onExit,
   onReady
}) => {
   const [sentence, setSentence] = useState('');
   const [selectedOption, setSelectedOption] = useState<string | null>(null);
   const [isChecking, setIsChecking] = useState(false);
   const [feedback, setFeedback] = useState<FeedbackResponse | null>(null);
   const [showHint, setShowHint] = useState(false);
   
   // Track the last question ID that had auto-audio played
   const playedQuestionIdRef = useRef<string | null>(null);

   const { refreshWallet, refreshPet } = usePet();
   
   const word = question.word;

   useEffect(() => {
      setSentence('');
      setSelectedOption(null);
      setFeedback(null);
      setShowHint(false);
   }, [question]);

   // Determine if submit is disabled
   const isSubmitDisabled = question.type === 'sentence' ? !sentence.trim() : !selectedOption;

   useEffect(() => {
      const t = setTimeout(() => { onReady?.(); }, 150);
      
      // Auto-play audio for Choice questions (Stage 1)
      // Only play if we haven't played for this question ID yet
      if (question.type === 'choice' && playedQuestionIdRef.current !== question.wordId) {
         playedQuestionIdRef.current = question.wordId;
         playPronunciation();
      }

      return () => clearTimeout(t);
   }, [question]);

   useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
         if (e.key === 'Enter') {
            if (feedback) {
               handleNext();
            } else if (!isSubmitDisabled && !isChecking) {
               handleSubmit();
            }
         } else if (question.type !== 'sentence' && !feedback && ['1', '2', '3', '4'].includes(e.key)) {
            const idx = parseInt(e.key) - 1;
            const targetOption = question.options?.[idx];
            if (targetOption) setSelectedOption(targetOption.id);
         }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
   }, [question, feedback, isSubmitDisabled, isChecking]);

   const handleSubmit = async () => {
      setIsChecking(true);
      setFeedback(null);

      try {
          if (question.type === 'sentence') {
             if (!sentence.trim()) return;
             const result = await evaluateSentence(word, sentence);
             setFeedback(result);
             if (result.isCorrect) {
                refreshWallet();
                refreshPet();
             }
          } else {
             // Choice / Quiz
             if (!selectedOption) return;
             const correctOpt = question.options?.find(o => o.isCorrect);
             const isCorrect = selectedOption === correctOpt?.id;
             setFeedback({
                isCorrect,
                feedback: isCorrect ? 'Correct!' : `The correct answer is ${correctOpt?.text}`
             });
             
             if (isCorrect) {
                 refreshWallet();
                 refreshPet();
             }
          }
      } catch {
         // Error handling
      } finally {
         setIsChecking(false);
      }
   };

   const handleNext = () => {
       const answer = question.type === 'sentence' ? sentence : selectedOption;
       if (feedback?.isCorrect) {
           onSuccess(question, answer);
       } else if (feedback && onFailure) {
           // 答错：把"曾经答过这一题"上报后端，让 SRS 的 wrongStreak/stage 降级能跑起来
           // 不算 streak、不发金币、不写 masteredItems
           onFailure(question, answer);
       } else {
           // 用户点 Skip 跳题,没答过,不上报
           onSkip();
       }
   };

   const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);

   const playPronunciation = () => {
      // Stop previous audio if playing
      if (currentAudio) {
         currentAudio.pause();
         currentAudio.currentTime = 0;
      }

      const audioUrl = `/api/learning/audio?word=${encodeURIComponent(word.word)}`;
      const audio = new Audio(audioUrl);
      setCurrentAudio(audio);
      
      audio.play().catch(() => {
         // Fallback to speech synthesis
         const utterance = new SpeechSynthesisUtterance(word.word);
         utterance.lang = 'en-US';
         // Stop previous speech
         window.speechSynthesis.cancel();
         window.speechSynthesis.speak(utterance);
      });
   };

   // Cleanup audio on unmount or question change
   useEffect(() => {
      return () => {
         if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
         }
         window.speechSynthesis.cancel();
      };
   }, [currentAudio]);

   const progressPercentage = ((currentIndex + 1) / totalCount) * 100;

   return (
      <div className="flex flex-col h-full w-full bg-white overflow-hidden">
         {/* Global Header */}
         <div className="h-16 flex items-center justify-between px-6 md:px-8 border-b-2 border-gray-100 bg-white shrink-0 gap-6 z-20">
            <button onClick={onExit} className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all shrink-0"><X size={22} /></button>
            <div className="flex flex-col flex-1 max-w-3xl mx-auto">
               <div className="flex justify-between text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                  <span>学习进度</span>
                  <span className="text-duo-green">{currentIndex + 1} / {totalCount}</span>
               </div>
               <div className="h-3 w-full bg-gray-200 rounded-full overflow-hidden">
                  <div
                     className="h-full bg-duo-yellow rounded-full transition-all duration-500 ease-out"
                     style={{ width: `${progressPercentage}%` }}
                  />
               </div>
            </div>
            <div className="w-10"></div> {/* Spacer to balance the X button */}
         </div>

         <div className="flex flex-col flex-1 overflow-hidden relative">
            {/* TOP COLUMN: Word/Question Display */}
            <div className="w-full py-8 md:py-10 bg-duo-blue relative flex flex-col items-center justify-center px-6 md:px-8 text-white shadow-none z-10 border-b-4 border-[#1899d6] shrink-0">
               
               <div className="relative z-10 text-center animate-fade-in-up">
                  <h1 className={`font-bold mb-4 leading-relaxed drop-shadow-sm break-words max-w-full ${
                     (question.type === 'sentence' ? word.word : question.questionText).length > 60
                        ? 'text-lg md:text-xl lg:text-2xl'
                        : (question.type === 'sentence' ? word.word : question.questionText).length > 30
                        ? 'text-xl md:text-2xl lg:text-3xl'
                        : (question.type === 'sentence' ? word.word : question.questionText).length > 10
                        ? 'text-2xl md:text-3xl lg:text-4xl'
                        : 'text-4xl md:text-5xl lg:text-6xl'
                  }`}>
                      {question.type === 'sentence' ? word.word : question.questionText}
                  </h1>

                  {question.type !== 'quiz' && (
                     <button
                        onClick={playPronunciation}
                        className="p-3.5 rounded-2xl bg-white/20 hover:bg-white/30 transition-all hover:scale-105 active:scale-95 border-b-4 border-black/10 mx-auto flex items-center justify-center"
                     >
                        <Volume2 size={26} />
                     </button>
                  )}

                  {question.type === 'sentence' && (
                      <div className="mt-6 max-w-xs mx-auto">
                         <p className="text-lg md:text-xl font-medium text-white/90 leading-relaxed">{word.definition}</p>
                      </div>
                  )}
               </div>
            </div>

            {/* BOTTOM COLUMN: Workspace */}
            <div className="flex-1 flex flex-col relative bg-white overflow-hidden">
               {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-4 md:p-8 flex flex-col justify-center">
                <div className="flex w-full max-w-7xl mx-auto justify-center gap-2 md:gap-4 items-center px-2 md:px-0">
                    
                    {/* Left Column: Feedback */}
                    <div className="w-[40%] md:w-auto md:flex-1 max-w-[320px] flex justify-end shrink" data-testid="feedback-container">
                        {feedback && (
                             <div className={`w-full rounded-2xl p-4 md:p-5 animate-slide-up border shadow-sm ${feedback.isCorrect ? 'bg-duo-green/10/80 border-duo-green/20' : 'bg-red-50/80 border-red-100'}`}>
                                <div className="flex flex-col lg:flex-row items-start gap-3">
                                   <div className={`p-2.5 rounded-xl shrink-0 ${feedback.isCorrect ? 'bg-duo-green/20 text-duo-green-dark' : 'bg-red-100 text-red-600'}`}>
                                      {feedback.isCorrect ? <CheckCircle2 size={22}/> : <AlertCircle size={22}/>} 
                                   </div>
                                   <div className="space-y-1.5 flex-1 w-full min-w-0 lg:self-center">
                                      <h3 className={`text-base md:text-lg font-bold ${feedback.isCorrect ? 'text-duo-green-dark' : 'text-red-900'} flex flex-wrap items-center gap-2`}>
                                         {feedback.isCorrect ? 'Correct!' : 'Incorrect'}
                                         {feedback.isCorrect && (
                                             <span className="text-[10px] md:text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full border border-yellow-200 animate-pulse whitespace-nowrap">
                                                 +{question.type === 'sentence' ? 10 : 1} Coin +{question.type === 'sentence' ? 10 : 1} Exp
                                             </span>
                                         )}
                                      </h3>
                                      {feedback.feedback !== 'Correct!' && (
                                         <p className="text-gray-600 leading-relaxed text-xs md:text-sm break-words">{feedback.feedback}</p>
                                      )}
                                      {feedback.improvedSentence && (
                                         <div className="mt-3 p-2 md:p-3 bg-white/60 rounded-xl border border-black/5">
                                            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Suggestion</p>
                                            <p className="text-gray-700 italic text-xs md:text-sm break-words">"{feedback.improvedSentence}"</p>
                                         </div>
                                      )}
                                   </div>
                                </div>
                             </div>
                        )}
                    </div>

                    {/* Center Column: Question */}
                    <div className="w-[60%] md:w-[540px] shrink" data-testid="question-container">
                        {question.type === 'sentence' ? (
                            <SentenceQuestion 
                                question={question}
                                sentence={sentence}
                                onSentenceChange={setSentence}
                                onSubmit={handleSubmit}
                                feedback={feedback}
                                isChecking={isChecking}
                                showHint={showHint}
                                onToggleHint={() => setShowHint(!showHint)}
                            />
                        ) : (
                            <MultipleChoiceQuestion 
                                question={{...question, questionText: ''}} // Hide question text as it is shown in left column
                                selectedOptionId={selectedOption}
                                onSelect={setSelectedOption}
                                showFeedback={!!feedback}
                            />
                        )}
                    </div>

                    {/* Right Column: Spacer (Desktop only) to ensure perfect centering */}
                    <div className="hidden md:block md:flex-1 max-w-[320px] shrink" aria-hidden="true" data-testid="spacer-container"></div>
                </div>
            </div>

            {/* Footer */}
            <div className="p-4 md:p-5 bg-white border-t-2 border-gray-100 shrink-0 flex items-center justify-between">
               <button onClick={onSkip} className="text-gray-400 hover:text-gray-600 font-bold uppercase tracking-wider px-6 py-3 hover:bg-gray-100 rounded-2xl transition-colors text-sm border-2 border-transparent hover:border-gray-200" disabled={isChecking}>Skip</button>

               {!feedback ? (
                  <Button
                     onClick={handleSubmit}
                     isLoading={isChecking}
                     disabled={isSubmitDisabled}
                     variant="duo-primary"
                     size="lg"
                  >
                     <span className="flex items-center gap-2">
                        Check Answer
                        <div className="flex items-center justify-center w-5 h-5 rounded bg-black/20 shadow-sm">
                           <CornerDownLeft size={13} strokeWidth={3} />
                        </div>
                     </span>
                  </Button>
               ) : (
                  <Button
                     onClick={handleNext}
                     variant="duo-primary"
                     size="lg"
                     className="animate-bounce-subtle"
                  >
                     <span className="flex items-center gap-2">
                        Next
                        <div className="flex items-center justify-center w-5 h-5 rounded bg-black/20 shadow-sm">
                           <CornerDownLeft size={13} strokeWidth={3} />
                        </div>
                     </span>
                  </Button>
               )}
            </div>
         </div>
      </div>
      </div>
   );
};
