import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@/lib/theme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Light / dark / system theme via a class on <html>; remembered per browser */}
    <ThemeProvider>
      <TooltipProvider delayDuration={200}>
        <App />
        <Toaster position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
