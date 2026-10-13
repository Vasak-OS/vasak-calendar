import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { computed, onScopeDispose, ref, watch } from 'vue';
import {
	type CalendarEvent,
	cuadricula,
	eventsByDay,
	primeroDelMes,
	rangoDe,
	sumarMeses,
} from '@/tools/mes';
import type { AccountSyncStatus, SyncRequestFailure } from '@/tools/sync-status';
import { civilDe, esZonaConocida, mismoDiaCivil, zonaDeLaSesion } from '@/tools/zona';

/** Dónde se recuerda en qué zona se quiere ver la agenda. */
const CLAVE_DE_ZONA = 'vasak-calendar.zona';

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

/** El aviso del programa de que cambió el estado de la sincronización. */
const SYNC_STATUS_EVENT = 'calendar-sync-status';

/** El aviso del programa de que cambió lo guardado del calendario. */
const STORE_CHANGED_EVENT = 'calendar-changed';

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

	/** Siempre el día 1: es la referencia del mes, no un día elegido. */
	const mes = ref(primeroDelMes(new Date(), zona.value));
	const cuentas = ref<Cuenta[]>([]);
	const calendarios = ref<Calendario[]>([]);
	const eventos = ref<CalendarEvent[]>([]);
	const cargando = ref(false);
	/** Lo que impidió leer algo, en el idioma de lo que la persona puede hacer. */
	const avisos = ref<string[]>([]);

	/**
	 * Cuál es la carga vigente.
	 *
	 * Sin esto, avanzar dos meses rápido deja dos pedidos en el aire y el que
	 * conteste último gana: la cuadrícula termina mostrando octubre con el título
	 * de noviembre. Cada carga se queda con su número y descarta su resultado si
	 * ya no es la última.
	 */
	let vigente = 0;

	const dias = computed(() => cuadricula(mes.value, zona.value, hoy.value));
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
			if (fromStore?.available) {
				calendarios.value = fromStore.calendarios;
				eventos.value = fromStore.eventos;
				nuevosAvisos.push(...fromStore.fallos);
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
				cargando.value = false;
			}
		}
	}

	/**
	 * Lee el rango del almacén. `null` si no se pudo —sin el servicio, sin
	 * permiso—: quien llama lee como antes, y no se avisa nada, porque el
	 * camino de siempre dice lo suyo si también falla.
	 */
	async function readFromStore(desde: string, hasta: string): Promise<StoreReading | null> {
		try {
			return await invoke<StoreReading>('store_events', { from: desde, to: hasta });
		} catch (e) {
			console.error('no se pudo leer el almacén del calendario', e);
			return null;
		}
	}

	/**
	 * El botón «Actualizar»: le pide al sincronizador que traiga ya lo nuevo de
	 * cada cuenta, y relee lo que hay mientras tanto. Lo que llegue después se
	 * avisa con [`STORE_CHANGED_EVENT`].
	 */
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
			const statuses = await invoke<AccountSyncStatus[]>('sync_status');
			syncStatuses.value = Array.isArray(statuses) ? statuses : [];
		} catch (e) {
			console.error('no se pudo leer el estado de la sincronización', e);
		}
	}

	async function refresh() {
		// Las que hay que reconectar no: el sincronizador no puede con ellas
		// hasta que la persona lo haga desde Configuración.
		const accountIds = cuentas.value.filter((c) => !c.necesita_reconectarse).map((c) => c.id);
		try {
			const failures = await invoke<SyncRequestFailure[]>('request_sync', { accountIds });
			refreshFailures.value = Array.isArray(failures) ? failures : [];
		} catch (e) {
			console.error('no se pudo pedir una vuelta al sincronizador', e);
			refreshFailures.value = accountIds.map((account_id) => ({
				account_id,
				reason: 'unavailable' as const,
			}));
		}
		await Promise.all([loadSyncStatus(), cargar()]);
	}

	async function irA(nuevo: Date) {
		mes.value = primeroDelMes(nuevo, zona.value);
		await cargar();
	}

	const mesAnterior = () => irA(sumarMeses(mes.value, -1, zona.value));
	const mesSiguiente = () => irA(sumarMeses(mes.value, 1, zona.value));
	const irAHoy = () => irA(new Date());

	/** Cambia en qué zona se mira la agenda. Vacío vuelve a la del sistema. */
	function elegirZona(nueva: string) {
		zonaElegida.value = nueva && esZonaConocida(nueva) ? nueva : '';
		guardarZona(zonaElegida.value);
	}

	// Cambiar de zona cambia qué días entran en la cuadrícula, así que hay que
	// volver a pedirle al servidor el rango nuevo: con otra zona, la primera y la
	// última celda son otras y sus eventos no están en memoria.
	//
	// El mes se recalcula contra la zona nueva **antes** de pedir. Sin eso, el
	// día 1 guardado es el instante del día 1 de la zona vieja, que en la nueva
	// puede ser el último día del mes anterior — y la cuadrícula se corre un mes
	// entero al cambiar de zona.
	watch(zona, async () => {
		mes.value = primeroDelMes(mes.value, zona.value);
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
	listen(SYNC_STATUS_EVENT, () => {
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
	listen(STORE_CHANGED_EVENT, () => {
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
		eventsOf,
		cargar,
		refresh,
		syncStatuses,
		refreshFailures,
		mesAnterior,
		mesSiguiente,
		irAHoy,
	};
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
