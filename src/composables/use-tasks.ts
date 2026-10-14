import { invoke } from '@tauri-apps/api/core';
import { onStoreChanged } from '@vasakgroup/plugin-vsk-store';
import { onScopeDispose, ref } from 'vue';
import type { Calendario, ConflictChoice, ConflictComparison } from '@/composables/use-calendario';
import { splitGlobalId } from '@/tools/event-form';
import { isStorePermissionDenied } from '@/tools/store-permission';
import { buildToggleDone, type TaskRef } from '@/tools/task-form';

/**
 * Una tarea tal como la da el almacén (`ListTasks`).
 *
 * Los nombres vienen del programa tal cual —Tauri no los convierte—, así que son
 * los de `StoredTask` en `src-tauri/src/store.rs` y, antes, los de `TaskItem` en
 * el servicio. El `etag` y el `sync_state` cumplen `SyncStatus`
 * (`tools/sync-state.ts`), así que la tarea reusa el badge y el candado de editar
 * del evento.
 */
export interface Task {
	/** El id global `cuenta/número`, con el que se edita, completa y borra. */
	task_id: string;
	/** El id global del calendario de la tarea. */
	calendar_id: string;
	title: string;
	/** El vencimiento en ISO 8601 (UTC), o nada si la tarea no tiene. */
	due?: string | null;
	all_day: boolean;
	/** `needs-action`, `in-process`, `completed`, `cancelled`, o vacío. */
	status: string;
	/** De 1 (la más alta) a 9, o nada. */
	priority?: number | null;
	completed?: string | null;
	/** Si la tarea está terminada: con esto se dibuja la casilla marcada. */
	done: boolean;
	color: string | null;
	/**
	 * El ETag, cuando el almacén lo entrega. Es lo que hace falta para editar o
	 * completar (`if_match`); mientras no esté, la tarea sólo se puede ver y
	 * borrar. Vacío en una creación local sin confirmar.
	 */
	etag?: string | null;
	/** `synced` (sin marca), `pending` (sin sincronizar) o `conflict`. */
	sync_state?: string;
}

/** Lo que contesta el almacén a una lectura de tareas (`store_tasks`). */
interface TaskReading {
	calendars: Calendario[];
	tasks: Task[];
	notices: string[];
	/** Si el almacén tiene alguna lista de tareas. Si no, no hay nada que mostrar. */
	available: boolean;
}

/**
 * Las tareas del almacén del sistema y las acciones para manejarlas.
 *
 * ── Por qué sólo del almacén, y no cuenta por cuenta ─────────────────────────
 *
 * A diferencia de los eventos —que tienen un camino viejo que lee del servidor
 * directo—, las tareas salen **sólo** del almacén del sistema (decisión 6: el
 * servicio del usuario mantiene la copia local y responde siempre él, desde la
 * caché, sin esperar a la red). Sin el almacén no hay de dónde leerlas, y la
 * vista lo dice en vez de inventar un camino que pediría la credencial.
 */
export function useTasks() {
	const calendars = ref<Calendario[]>([]);
	const tasks = ref<Task[]>([]);
	const loading = ref(false);
	/** Lo que impidió leer algo, ya listo para mostrar. */
	const notices = ref<string[]>([]);
	/** Si la persona le negó al almacén el permiso de leer el calendario. */
	const sinPermiso = ref(false);
	/** Si el almacén tiene alguna lista de tareas. Sin ninguna, no hay nada que crear. */
	const available = ref(false);
	/**
	 * Si entran también las tareas terminadas. Apagado por omisión: lo que importa
	 * de una lista de tareas es lo que falta hacer.
	 */
	const includeCompleted = ref(false);

	/**
	 * Cuál es la carga vigente. Sin esto, dos cargas rápidas —prender «ver
	 * completadas» justo tras abrir— dejan dos pedidos en el aire y gana el último
	 * que conteste, que puede no ser el de la elección actual.
	 */
	let vigente = 0;

	async function cargar() {
		const mio = ++vigente;
		loading.value = true;
		let huboDenegacion = false;
		const nuevosAvisos: string[] = [];
		try {
			const reading = await invoke<TaskReading>('store_tasks', {
				includeCompleted: includeCompleted.value,
			});
			if (mio !== vigente) {
				return;
			}
			if (!reading) {
				// El almacén no contestó nada: no hay tareas que mostrar.
				calendars.value = [];
				tasks.value = [];
				available.value = false;
				return;
			}
			calendars.value = reading.calendars;
			tasks.value = reading.tasks;
			available.value = reading.available;
			nuevosAvisos.push(...reading.notices);
		} catch (e) {
			if (mio !== vigente) {
				return;
			}
			if (isStorePermissionDenied(e)) {
				huboDenegacion = true;
				calendars.value = [];
				tasks.value = [];
				available.value = false;
				return;
			}
			// Sin el servicio, caído, un impostor: no hay tareas, y se avisa.
			console.error('no se pudieron leer las tareas', e);
			calendars.value = [];
			tasks.value = [];
			available.value = false;
			nuevosAvisos.push(String(e));
		} finally {
			if (mio === vigente) {
				notices.value = nuevosAvisos;
				sinPermiso.value = huboDenegacion;
				loading.value = false;
			}
		}
	}

	/** Prende o apaga «ver completadas» y relee: cambia qué pide al almacén. */
	async function setIncludeCompleted(value: boolean) {
		includeCompleted.value = value;
		await cargar();
	}

	/**
	 * Crea o edita una tarea en el almacén, y relee. Como con los eventos, el
	 * almacén guarda el crudo optimista al encolar, así que la relectura —de la
	 * caché— ya la trae. Devuelve el mensaje del fallo, o `null` si salió bien; un
	 * «no» de la persona enciende el estado de «sin permiso».
	 */
	async function writeTask(
		accountId: string,
		calendarId: string,
		payload: Record<string, unknown>,
		ifMatch: string
	): Promise<string | null> {
		try {
			await invoke('put_task', {
				accountId,
				calendarId,
				payload: JSON.stringify(payload),
				ifMatch,
			});
			await cargar();
			return null;
		} catch (e) {
			if (isStorePermissionDenied(e)) {
				sinPermiso.value = true;
			}
			console.error('no se pudo guardar la tarea', e);
			return String(e);
		}
	}

	/**
	 * Marca una tarea hecha o sin hacer desde la casilla de la lista. Es editar con
	 * el parche que fija el estado y el porcentaje (ver `buildToggleDone`), de forma
	 * optimista: la casilla cambia ya y, si la escritura falla, se vuelve a leer y
	 * la tarea recupera su estado. Devuelve el mensaje del fallo, o `null`.
	 */
	async function toggleDone(task: Task, done: boolean): Promise<string | null> {
		const built = buildToggleDone(task as TaskRef, done);
		if (!built.ok) {
			return built.error;
		}
		const antes = tasks.value;
		tasks.value = tasks.value.map((t) =>
			t.task_id === task.task_id ? { ...t, done, status: done ? 'completed' : 'needs-action' } : t
		);
		try {
			await invoke('put_task', {
				accountId: built.accountId,
				calendarId: built.calendarId,
				payload: JSON.stringify(built.patch),
				ifMatch: built.ifMatch,
			});
			await cargar();
			return null;
		} catch (e) {
			tasks.value = antes;
			if (isStorePermissionDenied(e)) {
				sinPermiso.value = true;
			}
			console.error('no se pudo completar la tarea', e);
			return String(e);
		}
	}

	/**
	 * Borra una tarea de forma optimista: se saca ya de la vista y el borrado se
	 * encola. No se relee en el acto —el almacén deja la fila marcada hasta que el
	 * servidor confirma, y una relectura la traería de vuelta—; el aviso de cambios
	 * trae la relectura definitiva. Si falla, la tarea vuelve a la vista.
	 */
	async function deleteTask(task: Task): Promise<string | null> {
		const parts = splitGlobalId(task.task_id);
		if (!parts) {
			return 'tareas.noSePuede';
		}
		const antes = tasks.value;
		tasks.value = tasks.value.filter((t) => t.task_id !== task.task_id);
		try {
			await invoke('delete_task', {
				accountId: parts.accountId,
				taskId: parts.localId,
				ifMatch: task.etag ?? '',
			});
			return null;
		} catch (e) {
			tasks.value = antes;
			if (isStorePermissionDenied(e)) {
				sinPermiso.value = true;
			}
			console.error('no se pudo borrar la tarea', e);
			return String(e);
		}
	}

	/**
	 * La comparación «la mía / la del servidor» de una tarea en conflicto, por su
	 * id global. Las tareas son objetos del área `calendar`, así que se usa el mismo
	 * comando que los eventos (`get_conflict`). `null` si ese id ya no está en
	 * conflicto o no se puede identificar.
	 */
	async function getConflict(taskUid: string): Promise<ConflictComparison | null> {
		const parts = splitGlobalId(taskUid);
		if (!parts) {
			return null;
		}
		return (
			(await invoke<ConflictComparison | null>('get_conflict', {
				accountId: parts.accountId,
				id: parts.localId,
			})) ?? null
		);
	}

	/**
	 * Resuelve el conflicto de una tarea con la elección de la persona, por el mismo
	 * comando que los eventos (`resolve_conflict`, área `calendar`), y relee.
	 * Devuelve el mensaje del fallo, o `null`.
	 */
	async function resolveConflict(taskUid: string, choice: ConflictChoice): Promise<string | null> {
		const parts = splitGlobalId(taskUid);
		if (!parts) {
			return 'tareas.noSePuede';
		}
		try {
			await invoke('resolve_conflict', {
				accountId: parts.accountId,
				id: parts.localId,
				choice,
			});
			await cargar();
			return null;
		} catch (e) {
			if (isStorePermissionDenied(e)) {
				sinPermiso.value = true;
			}
			console.error('no se pudo resolver el conflicto de la tarea', e);
			return String(e);
		}
	}

	// Lo nuevo que trae el sincronizador en segundo plano: se relee la lista. Sin
	// preguntar a intervalos.
	let descartado = false;
	let stopWatchingStore: (() => void) | null = null;
	onStoreChanged(() => {
		void cargar();
	})
		.then((cancelar) => {
			if (descartado) {
				cancelar();
				return;
			}
			stopWatchingStore = cancelar;
		})
		.catch((e) => {
			// Sin el aviso queda releer a mano: se pierde enterarse solo.
			console.error('no se pudo escuchar al almacén de tareas', e);
		});

	onScopeDispose(() => {
		descartado = true;
		stopWatchingStore?.();
	});

	return {
		calendars,
		tasks,
		loading,
		notices,
		sinPermiso,
		available,
		includeCompleted,
		cargar,
		setIncludeCompleted,
		writeTask,
		toggleDone,
		deleteTask,
		getConflict,
		resolveConflict,
	};
}
