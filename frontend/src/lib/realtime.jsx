import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { getToken } from './api.js';
import { useAuth } from './auth.jsx';

const RealtimeContext = createContext(null);

/** One Socket.IO connection per session; components subscribe with useRealtime(event, handler). */
export function RealtimeProvider({ children }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (!user) return undefined;
    const s = io(import.meta.env.VITE_SOCKET_URL || '/', { auth: { token: getToken() }, transports: ['websocket', 'polling'] });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the socket is an external resource created here
    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [user]);

  return <RealtimeContext.Provider value={socket}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(event, handler) {
  const socket = useContext(RealtimeContext);
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!socket) return undefined;
    const fn = (data) => ref.current(data);
    socket.on(event, fn);
    return () => socket.off(event, fn);
  }, [socket, event]);
}
