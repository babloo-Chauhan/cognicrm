import { EventEmitter } from 'node:events';

/** In-process event bus for normalized domain events (CALL_*, MESSAGE_*, ...). */
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

export function emitEvent(type, payload) {
  eventBus.emit(type, payload);
  eventBus.emit('*', { type, payload });
}
