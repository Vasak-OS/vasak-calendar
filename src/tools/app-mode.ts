/**
 * En qué parte de la aplicación se está: el calendario o las tareas.
 *
 * Es una preferencia de esta ventana, como la vista o la zona, y se recuerda en
 * `localStorage`. Todo el acceso va con `try`, porque en una ventana privada —o
 * con el almacenamiento bloqueado— hasta *leerlo* lanza, y una preferencia que no
 * se puede recordar no puede impedir abrir la aplicación.
 */

/** Las dos partes de la aplicación. */
export type AppMode = 'calendar' | 'tasks';

/** Con qué parte se abre: el calendario, que es lo que se venía viendo. */
export const DEFAULT_MODE: AppMode = 'calendar';

/** Dónde se recuerda la parte elegida. */
const MODE_KEY = 'vasak-calendar.mode';

/** Si un texto cualquiera es una parte conocida: lo guardado puede estar viejo. */
export function isAppMode(value: unknown): value is AppMode {
	return value === 'calendar' || value === 'tasks';
}

/** Qué parte quedó elegida la última vez; la de siempre si no hay o está vieja. */
export function savedMode(): AppMode {
	try {
		const guardada = window.localStorage.getItem(MODE_KEY);
		return isAppMode(guardada) ? guardada : DEFAULT_MODE;
	} catch {
		return DEFAULT_MODE;
	}
}

/** Recuerda la parte elegida. Si no se puede, se pierde al cerrar y nada más. */
export function saveMode(mode: AppMode) {
	try {
		window.localStorage.setItem(MODE_KEY, mode);
	} catch {
		// Se pierde al cerrar, y nada más. No vale la pena molestar con esto.
	}
}
