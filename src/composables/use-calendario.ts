import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
	type AccountSyncStatus,
	onStoreChanged,
	onSyncStatus,
	requestSync,
	type SyncRequestFailure,
	syncStatus,
} from '@vasakgroup/plugin-vsk-store';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { splitGlobalId } from '@/tools/event-form';
import { type CalendarEvent, eventsByDay, primeroDelMes, rangoDe } from '@/tools/mes';
import {
	isStorePermissionDenied,
	type ReaskOutcome,
	reaskNoticeKey,
	shouldReread,
} from '@/tools/store-permission';
import {
	type CalendarView,
	DEFAULT_VIEW,
	isCalendarView,
	stepAnchor,
	viewDays,
} from '@/tools/views';
import { civilDe, claveCivil, esZonaConocida, mismoDiaCivil, zonaDeLaSesion } from '@/tools/zona';

/** Dónde se recuerda en qué zona se quiere ver la agenda. */
const CLAVE_DE_ZONA = 'vasak-calendar.zona';

/** Dónde se recuerda con qué vista se mira el calendario. */
const VIEW_KEY = 'vasak-calendar.view';

/** El aviso del programa de que la máquina cambió de huso. Ver `reloj.rs`. */
const EVENTO_DE_ZONA = 'zona-cambio';

/**
 * Cada cuánto se mira si pasó la medianoche.
 *
 * El día marcado como «hoy» se calculaba una sola vez, al abrir, así que una
 * ventana abierta toda la noche amanecía con el círculo en el día de ayer.
 *
 * Un minuto no le cuesta nada a nadie —es una comparación— y es lo bastante
 * seguido como para que el cambio de día no se note tarde.
 */
const LATIDO = 60_000;

/** Una cuenta conectada que tiene calendarios. */
export interface Cuenta {
	id: string;
	nombre: string;
	/**
	 * Si hay que reconectarla desde Configuración antes de que vuelva a traer
	 * eventos.
	 *
	 * Se muestra igual: una cuenta que desaparece de la lista parece una cuenta
	 * que se borró, y la persona no sabría que le falta hacer algo.
	 */
	necesita_reconectarse: boolean;
}

/** Un calendario dentro de una cuenta. */
export interface Calendario {
	url: string;
	nombre: string;
	color: string | null;
}

interface LecturaDeCuenta {
	calendarios: Calendario[];
	eventos: CalendarEvent[];
	fallos: string[];
}

/** Lo que contesta el almacén del sistema: lo mismo, de todas las cuentas. */
interface StoreReading extends LecturaDeCuenta {
	/** Si el almacén tiene calendarios. Si no, se lee cuenta por cuenta. */
	available: boolean;
}

/** Cómo se resuelve un conflicto, igual que en `store.rs`. */
export type ConflictChoice = 'keep_local' | 'take_server';

/**
 * La comparación «la mía / la del servidor» de un evento en conflicto, como la
 * da `GetConflict` (ver `store.rs`). Los crudos son iCal.
 */
export interface ConflictComparison {
	id: string;
	/** `put` (creación o edición) o `delete` (borrado). */
	op: string;
	/** El iCal local sin confirmar. Ausente si el cambio local es un borrado. */
	local?: string | null;
	/** El iCal de la versión del servidor, si ya se trajo. */
	server?: string | null;
	server_etag?: string | null;
	/** Si todavía no hay copia del servidor con qué comparar. */
	server_unavailable: boolean;
}

/**
 * El mes que se está mirando y lo que hay en él.
 *
 * ── Por qué se avisa de lo que falló en vez de callarlo ──────────────────────
 *
 * Un mes vacío y un mes que no se pudo leer se ven exactamente igual: una
 * cuadrícula sin nada. La diferencia importa mucho —en uno la persona está libre
 * y en el otro no tiene idea de qué tiene—, así que lo que falla se muestra
 * arriba de la cuadrícula y no se descarta.
 */
export function useCalendario() {
	/**
	 * En qué zona horaria está la máquina.
	 *
	 * **La dice el programa, no el navegador.** Arranca con lo que contesta el
	 * motor —que para el primer dibujo es correcto y está ahí en el acto, sin
	 * esperar a nadie— y en cuanto contesta el programa se reemplaza por lo que
	 * dice el sistema.
	 *
	 * La diferencia no es de precisión sino de que el motor **no se entera de que
	 * cambió**: se queda con la zona que leyó al arrancar y contesta siempre lo
	 * mismo, así que una ventana abierta mientras el sistema cambia de huso —al
	 * viajar, con el reloj automático— seguiría mostrando la agenda con la hora
	 * del país anterior. El programa escucha el aviso del sistema y lo pasa.
	 */
	const zonaDelSistema = ref(zonaDeLaSesion());

	/** Le pregunta al programa, que le pregunta al sistema. */
	async function preguntarLaZona() {
		try {
			const delSistema = await invoke<string>('zona_del_sistema');
			if (esZonaConocida(delSistema)) {
				zonaDelSistema.value = delSistema;
			}
		} catch (e) {
			// No es un fallo que valga la pena mostrar: lo que contestó el motor
			// sirve, y lo único que se pierde es enterarse de un cambio de huso.
			console.error('no se pudo leer la zona horaria del sistema', e);
		}
	}

	/**
	 * En qué zona se quiere ver la agenda, o vacío para seguir a la del sistema.
	 *
	 * Vacío por omisión, que es lo que casi todo el mundo quiere. Elegir una la
	 * **fija**: es lo que pide quien viaja y quiere seguir viendo su agenda con
	 * la hora de su casa, para no reservar un vuelo a las tres de la mañana.
	 */
	const zonaElegida = ref(zonaGuardada());

	/** La zona contra la que se dibuja todo. */
	const zona = computed(() => zonaElegida.value || zonaDelSistema.value);

	/** Si lo que se está mirando no es la hora de acá. Se avisa. */
	const zonaAjena = computed(() => zona.value !== zonaDelSistema.value);

	/** Ahora, revisado cada tanto para que «hoy» no se quede en ayer. */
	const hoy = ref(new Date());

	/**
	 * Qué vista se está mirando: día, N días, semana, mes, año o agenda.
	 *
	 * Es una preferencia de esta ventana y se recuerda, como la zona. Lo
	 * guardado puede estar viejo —se renombró una vista, es de otra versión—, y
	 * entonces se cae a la de siempre en vez de quedar sin dibujar nada.
	 */
	const view = ref<CalendarView>(savedView());

	/**
	 * El día que la vista tiene como foco.
	 *
	 * Es **lo único** que mueven las flechas, y de él sale todo: el mes (su día
	 * 1), la semana (su lunes), el año (su año). Arranca en hoy, así que el mes
	 * se abre en el mes de hoy como siempre y el día, en el día de hoy.
	 */
	const anchor = ref<Date>(new Date());

	/**
	 * El primero del mes de `anchor`, para el título y para quien lo necesite.
	 *
	 * Se deriva de `anchor` y no se guarda aparte: así no hay dos referencias que
	 * se puedan contradecir —la del mes y la del día— cuando se cambia de vista.
	 */
	const mes = computed(() => primeroDelMes(anchor.value, zona.value));
	const cuentas = ref<Cuenta[]>([]);
	const calendarios = ref<Calendario[]>([]);
	const eventos = ref<CalendarEvent[]>([]);
	const cargando = ref(false);
	/** Lo que impidió leer algo, en el idioma de lo que la persona puede hacer. */
	const avisos = ref<string[]>([]);
	/**
	 * Si la persona le negó al almacén el permiso de leer el calendario.
	 *
	 * Es distinto de que el almacén no esté: con el «no» no se va al servidor
	 * —eso pediría la credencial de la cuenta, que es más que lo que acaba de
	 * negar—, se muestra el estado de «sin permiso» con su botón. Se decide al
	 * final de cada carga, para que un relee con el permiso ya concedido lo
	 * apague solo.
	 */
	const sinPermiso = ref(false);

	/**
	 * Cuál es la carga vigente.
	 *
	 * Sin esto, avanzar dos meses rápido deja dos pedidos en el aire y el que
	 * conteste último gana: la cuadrícula termina mostrando octubre con el título
	 * de noviembre. Cada carga se queda con su número y descarta su resultado si
	 * ya no es la última.
	 */
	let vigente = 0;

	/** Los días que la vista muestra y que acotan lo que se le pide al almacén. */
	const dias = computed(() => viewDays(view.value, anchor.value, zona.value, hoy.value));
	const eventosPorDia = computed(() => eventsByDay(eventos.value, dias.value, zona.value));

	/** Los eventos de un día de la cuadrícula. */
	function eventsOf(clave: string): CalendarEvent[] {
		return eventosPorDia.value.get(clave) ?? [];
	}

	async function cargar() {
		const mio = ++vigente;
		cargando.value = true;
		// Los avisos se limpian **acá**, al empezar, y no después de traer los
		// datos: limpiarlos al final borra justo lo que esta carga acaba de
		// descubrir, y el aviso no llega a verse nunca.
		const nuevosAvisos: string[] = [];
		// Si el almacén chocó con el «no» de la persona. Se decide al final, para
		// que un relee con el permiso ya concedido lo apague solo.
		let huboDenegacion = false;

		try {
			const conectadas = await invoke<Cuenta[]>('listar_cuentas');
			if (mio !== vigente) {
				return;
			}
			// Una respuesta que no es lista se toma como ninguna cuenta: la
			// ventana se dibuja con `cuentas` mientras se lee el almacén, y no
			// puede quedar sin valor en el medio.
			cuentas.value = Array.isArray(conectadas) ? conectadas : [];

			const { desde, hasta } = rangoDe(dias.value, zona.value);

			// **Primero lo que ya está sincronizado en el sistema**: aparece sin
			// esperar a la red, de todas las cuentas a la vez y con las series ya
			// expandidas. Sólo si el almacén todavía no tiene calendarios —el
			// área no se encendió, la primera vuelta no terminó— se va al
			// servidor cuenta por cuenta, como antes.
			const fromStore = await readFromStore(desde, hasta);
			if (mio !== vigente) {
				return;
			}
			// El «no» al almacén no se esquiva yendo al servidor: eso pediría la
			// credencial de la cuenta, que es más que lo que la persona acaba de
			// negar. La vista muestra el estado de «sin permiso» con su botón.
			if (fromStore.kind === 'denied') {
				huboDenegacion = true;
				calendarios.value = [];
				eventos.value = [];
				return;
			}
			if (fromStore.kind === 'ready' && fromStore.reading.available) {
				calendarios.value = fromStore.reading.calendarios;
				eventos.value = fromStore.reading.eventos;
				nuevosAvisos.push(...fromStore.reading.fallos);
				return;
			}

			const nuevosEventos: CalendarEvent[] = [];
			const nuevosCalendarios: Calendario[] = [];

			for (const cuenta of cuentas.value) {
				if (cuenta.necesita_reconectarse) {
					// No se intenta: el servicio ya sabe que la credencial no
					// sirve, y pedirla sólo agrega un error técnico encima de un
					// aviso que ya dice qué hacer.
					continue;
				}
				try {
					const lectura = await invoke<LecturaDeCuenta>('account_events', {
						accountId: cuenta.id,
						from: desde,
						to: hasta,
					});
					nuevosCalendarios.push(...lectura.calendarios);
					nuevosEventos.push(...lectura.eventos);
					nuevosAvisos.push(...lectura.fallos);
				} catch (e) {
					// Una cuenta que falla no puede vaciar el mes de las otras.
					// Con el nombre adelante: «no se pudo leer» no le dice a nadie
					// cuál de sus dos cuentas es la que está rota.
					nuevosAvisos.push(`${cuenta.nombre}: ${e}`);
				}
			}

			if (mio !== vigente) {
				return;
			}
			calendarios.value = nuevosCalendarios;
			eventos.value = nuevosEventos;
		} catch (e) {
			if (mio !== vigente) {
				return;
			}
			// Que no esté el servicio de cuentas no es un fallo del calendario:
			// simplemente no hay nada conectado que mostrar.
			cuentas.value = [];
			calendarios.value = [];
			eventos.value = [];
			nuevosAvisos.push(String(e));
		} finally {
			if (mio === vigente) {
				avisos.value = nuevosAvisos;
				sinPermiso.value = huboDenegacion;
				cargando.value = false;
			}
		}
	}

	/**
	 * Lo que contesta el almacén a una lectura: lo que trajo, un «no» de la
	 * persona, o que no está disponible —sin el servicio, caído, un impostor en
	 * el nombre—. El «no» se separa de lo no disponible porque la ventana los
	 * resuelve distinto: con el «no» muestra el estado de «sin permiso»; sin el
	 * servicio lee cuenta por cuenta.
	 */
	type StoreResult =
		| { kind: 'ready'; reading: StoreReading }
		| { kind: 'denied' }
		| { kind: 'unavailable' };

	/** Lee el rango del almacén y separa el «no» de la persona de lo no disponible. */
	async function readFromStore(desde: string, hasta: string): Promise<StoreResult> {
		try {
			const reading = await invoke<StoreReading>('store_events', { from: desde, to: hasta });
			// Una respuesta vacía —el comando contestó `undefined`— no es el mes:
			// se lee cuenta por cuenta, como cuando el almacén no tiene nada.
			if (!reading) {
				return { kind: 'unavailable' };
			}
			return { kind: 'ready', reading };
		} catch (e) {
			if (isStorePermissionDenied(e)) {
				return { kind: 'denied' };
			}
			// Sin permiso no: sin el servicio, caído. No se avisa nada, porque el
			// camino de siempre dice lo suyo si también falla.
			console.error('no se pudo leer el almacén del calendario', e);
			return { kind: 'unavailable' };
		}
	}

	/**
	 * Vuelve a pedir el permiso del almacén y, si se reabrió el diálogo, relee:
	 * esa lectura es la que lo hace aparecer. Si la persona vuelve a decir que
	 * no, el calendario sigue en «sin permiso». Devuelve la clave del aviso
	 * cuando no se pudo **ni reabrir** —el techo de frecuencia, un recurso
	 * ajeno, el servicio caído—, para que la vista la traduzca; `null` cuando sí
	 * se reabrió.
	 */
	async function pedirPermisoDeNuevo(): Promise<string | null> {
		let outcome: ReaskOutcome | undefined;
		try {
			outcome = await invoke<ReaskOutcome>('request_calendar_access_again');
		} catch (e) {
			console.error('no se pudo volver a pedir el permiso del calendario', e);
			return 'permiso.error';
		}
		if (shouldReread(outcome)) {
			await cargar();
		}
		return reaskNoticeKey(outcome);
	}

	/**
	 * El día que la vista tiene como foco, `AAAA-MM-DD` en la zona de la agenda:
	 * con él se abre el formulario de crear, en el día que se está mirando.
	 */
	const focusDay = computed(() => claveCivil(civilDe(anchor.value, zona.value)));

	/**
	 * Crea o edita un evento en el almacén, y relee.
	 *
	 * No hace falta inventar un evento provisorio en la vista: el almacén guarda
	 * el crudo **optimista** al encolar la escritura, así que la relectura —que
	 * sale de la caché, sin esperar a la red— ya lo trae. Cuando el servidor
	 * confirme, el aviso `vsk-store://changed` dispara otra relectura sola.
	 *
	 * Devuelve el mensaje del fallo para que el formulario lo muestre, o `null` si
	 * salió bien. Un «no» de la persona enciende además el estado de «sin
	 * permiso», como en la lectura.
	 */
	async function writeEvent(
		accountId: string,
		calendarId: string,
		payload: Record<string, unknown>,
		ifMatch: string
	): Promise<string | null> {
		try {
			await invoke('put_event', {
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
			console.error('no se pudo guardar el evento', e);
			return String(e);
		}
	}

	/**
	 * Borra un evento —la serie entera—, de forma optimista: se saca ya de la
	 * vista y el borrado se encola hacia el servidor. No se relee en el acto: el
	 * almacén deja la fila marcada hasta que el servidor confirma, y una
	 * relectura la traería de vuelta; el aviso de cambios trae la relectura
	 * definitiva cuando de verdad ya no está. Si la escritura falla, se vuelve a
	 * leer para que el evento reaparezca: no se perdió.
	 */
	async function deleteEvent(event: CalendarEvent): Promise<string | null> {
		const parts = splitGlobalId(event.uid);
		if (!parts) {
			return 'editor.noSePuede';
		}
		const antes = eventos.value;
		eventos.value = eventos.value.filter((e) => e.uid !== event.uid);
		try {
			await invoke('delete_event', {
				accountId: parts.accountId,
				eventId: parts.localId,
				ifMatch: event.etag ?? '',
			});
			return null;
		} catch (e) {
			// Volvió a fallar: se restaura lo que había y se avisa.
			eventos.value = antes;
			if (isStorePermissionDenied(e)) {
				sinPermiso.value = true;
			}
			console.error('no se pudo borrar el evento', e);
			return String(e);
		}
	}

	/**
	 * La comparación «la mía / la del servidor» de un evento en conflicto, por su
	 * id global `cuenta/número`. `null` si ese id ya no está en conflicto —el
	 * almacén lo resolvió— o si no se puede identificar. Un fallo se lanza para
	 * que la vista muestre que no se pudo traer la comparación.
	 */
	async function getConflict(eventUid: string): Promise<ConflictComparison | null> {
		const parts = splitGlobalId(eventUid);
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
	 * Resuelve un conflicto: `keep_local` deja que mi versión pise a la del
	 * servidor, `take_server` adopta la del servidor. Relee en el acto además del
	 * aviso `vsk-store://changed`, para que el estado del evento se actualice sin
	 * esperar. Devuelve el mensaje del fallo, o `null` si salió bien; un «no» de
	 * la persona enciende el estado de «sin permiso», como en la lectura.
	 */
	async function resolveConflict(eventUid: string, choice: ConflictChoice): Promise<string | null> {
		const parts = splitGlobalId(eventUid);
		if (!parts) {
			return 'editor.noSePuede';
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
			console.error('no se pudo resolver el conflicto', e);
			return String(e);
		}
	}

	/** El estado de la sincronización de cada cuenta, del almacén. */
	const syncStatuses = ref<AccountSyncStatus[]>([]);
	/** Las cuentas a las que el último «Actualizar» no les pudo pedir una vuelta. */
	const refreshFailures = ref<SyncRequestFailure[]>([]);

	/**
	 * Lee el estado de la sincronización. Si no se puede, se deja el que había:
	 * no saber el estado no es un error que haya que mostrar encima del mes.
	 */
	async function loadSyncStatus() {
		try {
			syncStatuses.value = await syncStatus('calendar');
		} catch (e) {
			console.error('no se pudo leer el estado de la sincronización', e);
		}
	}

	/**
	 * El botón «Actualizar»: le pide al sincronizador que traiga ya lo nuevo de
	 * cada cuenta, y relee lo que hay mientras tanto. Lo que llegue después se
	 * avisa con el aviso de cambios del almacén.
	 */
	async function refresh() {
		// Las que hay que reconectar no: el sincronizador no puede con ellas
		// hasta que la persona lo haga desde Configuración.
		const accountIds = cuentas.value.filter((c) => !c.necesita_reconectarse).map((c) => c.id);
		try {
			refreshFailures.value = await requestSync(accountIds);
		} catch (e) {
			console.error('no se pudo pedir una vuelta al sincronizador', e);
			refreshFailures.value = accountIds.map((account_id) => ({
				account_id,
				reason: 'unavailable' as const,
			}));
		}
		await Promise.all([loadSyncStatus(), cargar()]);
	}

	/** Lleva el foco a un día y vuelve a leer el rango nuevo. */
	async function irA(nuevo: Date) {
		anchor.value = nuevo;
		await cargar();
	}

	/** La flecha de ir atrás, según la vista: un día, una semana, un mes, un año. */
	const goPrevious = () => irA(stepAnchor(view.value, anchor.value, zona.value, -1));
	/** La flecha de ir adelante, según la vista. */
	const goNext = () => irA(stepAnchor(view.value, anchor.value, zona.value, 1));
	/** «Hoy»: lleva el foco al día de hoy, sin cambiar de vista. */
	const goToToday = () => irA(new Date());

	/**
	 * Cambia de vista. Guarda la elección y relee, porque cada vista pide un
	 * rango distinto —un día, una semana, un año— y lo que hay en memoria es el
	 * del rango anterior.
	 */
	async function setView(next: CalendarView) {
		view.value = next;
		guardarView(next);
		await cargar();
	}

	/**
	 * Abre un día —o un mes— concreto en la vista que se pida: es lo que usan la
	 * vista de año (tocar un día va al día; tocar el mes va al mes) y cualquier
	 * salto parecido.
	 */
	async function show(fecha: Date, kind: CalendarView) {
		anchor.value = fecha;
		view.value = kind;
		guardarView(kind);
		await cargar();
	}

	/** Cambia en qué zona se mira la agenda. Vacío vuelve a la del sistema. */
	function elegirZona(nueva: string) {
		zonaElegida.value = nueva && esZonaConocida(nueva) ? nueva : '';
		guardarZona(zonaElegida.value);
	}

	// Cambiar de zona cambia qué días entran en la vista, así que hay que volver
	// a pedirle al servidor el rango nuevo: con otra zona, la primera y la última
	// celda son otras y sus eventos no están en memoria.
	//
	// Ya no hace falta recalcular nada a mano: el mes se deriva de `anchor` con
	// la zona vigente (`primeroDelMes`), así que no puede quedar corrido un mes
	// al cambiar de huso como pasaba con el día 1 guardado aparte.
	watch(zona, async () => {
		await cargar();
	});

	// La zona de verdad, y el aviso de cuando cambie.
	preguntarLaZona();
	let dejarDeEscuchar: UnlistenFn | null = null;
	let descartado = false;
	listen<string>(EVENTO_DE_ZONA, (aviso) => {
		if (esZonaConocida(aviso.payload)) {
			zonaDelSistema.value = aviso.payload;
		}
	})
		.then((cancelar) => {
			// La ventana se puede cerrar antes de que esto termine de engancharse, y
			// entonces no habría quién cancele: el oyente quedaría vivo apuntando a
			// una vista que ya no existe.
			if (descartado) {
				cancelar();
				return;
			}
			dejarDeEscuchar = cancelar;
		})
		.catch((e) => {
			// Sin el aviso, la zona igual se vuelve a leer cada vez que se vuelve a
			// la ventana. Se pierde enterarse en el momento, no enterarse.
			console.error('no se pudo escuchar el cambio de zona horaria', e);
		});

	// El estado de la sincronización, cada vez que cambia. Un «se pidió hace un
	// momento» deja de valer en cuanto hay una vuelta en marcha.
	let stopWatchingStatus: UnlistenFn | null = null;
	void loadSyncStatus();
	onSyncStatus(() => {
		refreshFailures.value = refreshFailures.value.filter((f) => f.reason !== 'too_soon');
		void loadSyncStatus();
	})
		.then((cancelar) => {
			if (descartado) {
				cancelar();
				return;
			}
			stopWatchingStatus = cancelar;
		})
		.catch((e) => {
			console.error('no se pudo escuchar el estado de la sincronización', e);
		});

	// Lo nuevo que trae el sincronizador en segundo plano: se relee el mes a
	// la vista. Sin preguntar a intervalos.
	let stopWatchingStore: UnlistenFn | null = null;
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
			// Sin el aviso queda el botón de actualizar: se pierde enterarse solo.
			console.error('no se pudo escuchar al almacén del calendario', e);
		});

	const latido = setInterval(() => {
		const ahora = new Date();
		// Sólo si cambió el día, y **el día de la zona que se está mirando**:
		// asignar un `Date` nuevo cada minuto rehace la cuadrícula entera sesenta
		// veces por hora para nada, y mirar el día del sistema dejaría el círculo
		// en el de ayer hasta que acá cambie la fecha — que no es cuando cambia
		// allá.
		if (!mismoDiaCivil(civilDe(ahora, zona.value), civilDe(hoy.value, zona.value))) {
			hoy.value = ahora;
		}
	}, LATIDO);

	// Al volver a la ventana, sin esperar a nada: quien vuelve después de
	// suspender el equipo en otro país tiene que ver la agenda bien de entrada, y
	// un aviso del bus puede haberse perdido mientras el equipo dormía.
	const alVolver = () => {
		hoy.value = new Date();
		preguntarLaZona();
	};
	window.addEventListener('focus', alVolver);

	onScopeDispose(() => {
		descartado = true;
		clearInterval(latido);
		window.removeEventListener('focus', alVolver);
		dejarDeEscuchar?.();
		stopWatchingStore?.();
		stopWatchingStatus?.();
	});

	return {
		mes,
		view,
		anchor,
		setView,
		show,
		zona,
		zonaElegida,
		zonaDelSistema,
		zonaAjena,
		elegirZona,
		dias,
		cuentas,
		calendarios,
		eventos,
		cargando,
		avisos,
		sinPermiso,
		eventsOf,
		cargar,
		refresh,
		focusDay,
		writeEvent,
		deleteEvent,
		getConflict,
		resolveConflict,
		pedirPermisoDeNuevo,
		syncStatuses,
		refreshFailures,
		goPrevious,
		goNext,
		goToToday,
	};
}

/**
 * Qué vista quedó elegida la última vez.
 *
 * En `localStorage`, como la zona: es una preferencia de esta ventana, no un
 * dato de la persona. Todo el acceso va con `try`, porque en una ventana
 * privada —o con el almacenamiento bloqueado— hasta *leerlo* lanza, y una
 * preferencia que no se puede recordar no puede impedir abrir el calendario.
 * Una vista guardada que ya no existe se descarta y se cae a la de siempre.
 */
function savedView(): CalendarView {
	try {
		const guardada = window.localStorage.getItem(VIEW_KEY);
		return isCalendarView(guardada) ? guardada : DEFAULT_VIEW;
	} catch {
		return DEFAULT_VIEW;
	}
}

function guardarView(view: CalendarView) {
	try {
		window.localStorage.setItem(VIEW_KEY, view);
	} catch {
		// Se pierde al cerrar, y nada más. No vale la pena molestar con esto.
	}
}

/**
 * Qué zona quedó elegida la última vez.
 *
 * En `localStorage` y no en un archivo: es una preferencia de esta ventana, no
 * un dato de la persona. Todo el acceso va con `try`, porque en una ventana
 * privada —o con el almacenamiento del sitio bloqueado— *leerlo* ya lanza, y una
 * preferencia que no se puede recordar no puede impedir abrir el calendario.
 *
 * Una zona guardada que el motor ya no conoce se descarta: las zonas de IANA se
 * renombran, y quedarse con una que no existe dejaría la agenda sin dibujar.
 */
function zonaGuardada(): string {
	try {
		const guardada = window.localStorage.getItem(CLAVE_DE_ZONA) ?? '';
		return esZonaConocida(guardada) ? guardada : '';
	} catch {
		return '';
	}
}

function guardarZona(zona: string) {
	try {
		if (zona) {
			window.localStorage.setItem(CLAVE_DE_ZONA, zona);
		} else {
			window.localStorage.removeItem(CLAVE_DE_ZONA);
		}
	} catch {
		// Se pierde al cerrar, y nada más. No vale la pena molestar con esto.
	}
}
