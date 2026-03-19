'use client';

import {
  createContext,
  useContext,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';

type DialFn = (number: string, fromNumber?: string) => void;

type CallContextType = {
  /** Trigger a call from the CallWidget via Voice SDK (WebRTC) */
  dial: DialFn;
  /** Used internally by CallWidget to register its dial handler */
  registerDialHandler: (handler: DialFn) => void;
};

const CallContext = createContext<CallContextType | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<DialFn | null>(null);

  const registerDialHandler = useCallback((handler: DialFn) => {
    handlerRef.current = handler;
  }, []);

  const dial: DialFn = useCallback((number, fromNumber) => {
    if (handlerRef.current) {
      handlerRef.current(number, fromNumber);
    } else {
      console.warn('[CallContext] No dial handler registered — is CallWidget mounted?');
    }
  }, []);

  return (
    <CallContext.Provider value={{ dial, registerDialHandler }}>
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return ctx;
}
