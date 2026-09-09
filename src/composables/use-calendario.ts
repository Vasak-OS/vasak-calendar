import { invoke } from '@tauri-apps/api/core';
import { computed, ref } from 'vue';
import { claveDe, cuadricula, type Evento, porDia, rangoDe, sumarMeses } from '@/tools/mes';

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
	eventos: Evento[];
	fallos: string[];
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
	/** Siempre el día 1: es la referencia del mes, no un día elegido. */
	const mes = ref(primeroDelMes(new Date()));
	const cuentas = ref<Cuenta[]>([]);
	const calendarios = ref<Calendario[]>([]);
	const eventos = ref<Evento[]>([]);
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

	const dias = computed(() => cuadricula(mes.value));
	const eventosPorDia = computed(() => porDia(eventos.value, dias.value));

	/** Los eventos de un día de la cuadrícula. */
	function eventosDe(fecha: Date): Evento[] {
		return eventosPorDia.value.get(claveDe(fecha)) ?? [];
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
			cuentas.value = conectadas;

			const { desde, hasta } = rangoDe(dias.value);
			const nuevosEventos: Evento[] = [];
			const nuevosCalendarios: Calendario[] = [];

			for (const cuenta of conectadas) {
				if (cuenta.necesita_reconectarse) {
					// No se intenta: el servicio ya sabe que la credencial no
					// sirve, y pedirla sólo agrega un error técnico encima de un
					// aviso que ya dice qué hacer.
					continue;
				}
				try {
					const lectura = await invoke<LecturaDeCuenta>('eventos_de_la_cuenta', {
						accountId: cuenta.id,
						desde,
						hasta,
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

	async function irA(nuevo: Date) {
		mes.value = primeroDelMes(nuevo);
		await cargar();
	}

	const mesAnterior = () => irA(sumarMeses(mes.value, -1));
	const mesSiguiente = () => irA(sumarMeses(mes.value, 1));
	const irAHoy = () => irA(new Date());

	return {
		mes,
		dias,
		cuentas,
		calendarios,
		eventos,
		cargando,
		avisos,
		eventosDe,
		cargar,
		mesAnterior,
		mesSiguiente,
		irAHoy,
	};
}

function primeroDelMes(fecha: Date): Date {
	return new Date(fecha.getFullYear(), fecha.getMonth(), 1);
}
