<script setup lang="ts">
/**
 * Un desplegable dibujado entero por la aplicación.
 *
 * ── Por qué no un `<select>` ────────────────────────────────────────────────
 *
 * Porque la lista desplegada de un `<select>` **la dibuja el sistema**, no la
 * página: no toma los colores del tema, y en una ventana oscura aparecía un
 * rectángulo blanco que no se parecía a nada del resto del escritorio. Se le
 * puede dar color al control cerrado y a cada `<option>`, pero el menú abierto
 * queda fuera de alcance.
 *
 * Y hay un segundo motivo que pesa igual: son más de cuatrocientas zonas
 * horarias. Un `<select>` con eso adentro obliga a desplazar a ciegas — no hay
 * forma de llegar a «America/Argentina/Buenos_Aires» sin recorrer medio
 * abecedario. Con un campo de búsqueda arriba se llega escribiendo tres letras.
 *
 * ── Por qué está escrito a mano ─────────────────────────────────────────────
 *
 * `<input list>` con `<datalist>` sería lo natural y WebKitGTK lo dibuja de
 * forma inconsistente. Y una biblioteca de componentes sería una dependencia
 * entera para una lista. El mismo razonamiento, y buena parte de este código,
 * vienen de `vasak-installer`, donde el caso que lo motivó fue justamente elegir
 * la zona horaria.
 *
 * ── El teclado ──────────────────────────────────────────────────────────────
 *
 * Un desplegable que sólo se usa con el mouse no es un desplegable. Las flechas
 * mueven, `Enter` elige, `Escape` cierra y devuelve el foco al botón, y
 * `aria-activedescendant` es lo que hace que un lector de pantalla diga por cuál
 * está pasando sin que el foco se mueva del campo de búsqueda.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useReactiveIcons } from '@/composables/useReactiveIcon';
import { buscarOpciones, type Opcion } from '@/tools/buscar';

const props = withDefaults(
	defineProps<{
		modelValue: string;
		opciones: Opcion[];
		etiqueta: string;
		placeholderBusqueda: string;
		textoSinResultados: string;
		/** Lo que se muestra cuando no hay nada elegido. */
		textoVacio?: string;
		disabled?: boolean;
		/** Cuántas opciones se dibujan como máximo. Ver el comentario de abajo. */
		tope?: number;
		/**
		 * Si el menú se abre hacia arriba.
		 *
		 * Hace falta cuando el control vive al pie de un panel: hacia abajo, el
		 * menú se sale de la ventana y no hay forma de llegar al final de la
		 * lista.
		 */
		haciaArriba?: boolean;
	}>(),
	{ disabled: false, tope: 60, haciaArriba: false, textoVacio: '—' }
);

const emit = defineEmits<(e: 'update:modelValue', valor: string) => void>();

const { flecha } = useReactiveIcons({ flecha: 'go-down' });

const busqueda = ref('');
const abierto = ref(false);
const activa = ref(0);
const campo = ref<HTMLInputElement | null>(null);
const lista = ref<HTMLElement | null>(null);
const boton = ref<HTMLButtonElement | null>(null);

/** Único por instancia, para que `aria-activedescendant` apunte a lo suyo. */
const idLista = `selector-${Math.random().toString(36).slice(2, 9)}`;

const seleccionada = computed(
	() => props.opciones.find((o) => o.valor === props.modelValue) ?? null
);

/**
 * Las coincidencias, ordenadas por qué tan bien coinciden y recortadas al tope.
 *
 * El recorte no es una optimización prematura: sin él, con la búsqueda vacía se
 * dibujan cuatrocientos nodos, y como este cálculo corre en cada tecla, cada
 * letra tipeada recrea la lista entera.
 *
 * **El orden es lo que hace que el recorte sea seguro.** Recortar una lista
 * alfabética esconde justo lo que se busca. La lógica del orden y sus pruebas
 * están en `tools/buscar.ts`.
 */
const ordenadas = computed(() => buscarOpciones(props.opciones, busqueda.value));
const coincidencias = computed(() => ordenadas.value.slice(0, props.tope));

/** Cuántas quedaron afuera del recorte, para poder decirlo en vez de esconderlas. */
const sobrantes = computed(() => Math.max(0, ordenadas.value.length - props.tope));

function elegir(valor: string) {
	emit('update:modelValue', valor);
	cerrar();
}

async function abrir() {
	if (props.disabled) {
		return;
	}
	abierto.value = true;
	// Arranca sobre la que está elegida, no sobre la primera: así bajar una vez
	// lleva a la siguiente de la que se tiene, que es lo que se espera.
	const donde = coincidencias.value.findIndex((o) => o.valor === props.modelValue);
	activa.value = donde >= 0 ? donde : 0;

	// El foco va al campo de búsqueda al abrir. Sin esto hay que hacer un clic
	// más para poder escribir, que es justamente lo que este componente evita.
	await nextTick();
	campo.value?.focus();
	desplazarALaActiva();
}

function cerrar(devolverElFoco = true) {
	if (!abierto.value) {
		return;
	}
	abierto.value = false;
	busqueda.value = '';
	// El foco vuelve al botón: si se quedara en un campo que ya no existe, el
	// navegador lo manda al principio del documento y quien usa teclado pierde
	// el lugar.
	if (devolverElFoco) {
		nextTick(() => boton.value?.focus());
	}
}

function mover(paso: number) {
	const total = coincidencias.value.length;
	if (total === 0) {
		return;
	}
	// Da la vuelta: bajar desde la última lleva a la primera, que es lo que hace
	// cualquier menú.
	activa.value = (activa.value + paso + total) % total;
	desplazarALaActiva();
}

function desplazarALaActiva() {
	nextTick(() => {
		lista.value
			?.querySelector(`[data-indice="${activa.value}"]`)
			?.scrollIntoView({ block: 'nearest' });
	});
}

function elegirLaActiva() {
	const opcion = coincidencias.value[activa.value];
	if (opcion) {
		elegir(opcion.valor);
	}
}

// Escribir mueve la lista bajo el cursor, así que la marca vuelve arriba. Sin
// esto, `Enter` después de escribir elegía una opción que ya no estaba a la
// vista.
watch(busqueda, () => {
	activa.value = 0;
	desplazarALaActiva();
});

/**
 * Cerrar al hacer clic afuera.
 *
 * En `focusout` y no en un oyente de `click` en el documento: `focusout` no
 * necesita registrar nada global —que después hay que acordarse de sacar— y
 * cubre además el caso de salir con `Tab`, que un oyente de clic no ve.
 *
 * `relatedTarget` es a dónde se fue el foco; si sigue adentro del componente,
 * no se cierra.
 */
function alPerderElFoco(evento: FocusEvent) {
	const destino = evento.relatedTarget as Node | null;
	if (destino && (evento.currentTarget as HTMLElement).contains(destino)) {
		return;
	}
	cerrar(false);
}
</script>

<template>
  <div class="relative" @focusout="alPerderElFoco">
    <button
      ref="boton"
      type="button"
      :disabled="disabled"
      class="flex w-full items-center justify-between gap-2 rounded-corner border border-ui-border-strong bg-ui-surface px-2 py-1 text-left text-sm text-tx-main transition-colors hover:bg-ui-bg/60 disabled:cursor-not-allowed disabled:opacity-50"
      :aria-label="etiqueta"
      :aria-expanded="abierto"
      aria-haspopup="listbox"
      @click="abierto ? cerrar() : abrir()"
      @keydown.down.prevent="abierto ? mover(1) : abrir()"
      @keydown.up.prevent="abierto ? mover(-1) : abrir()">
      <span class="min-w-0 flex-1 truncate">
        {{ seleccionada?.etiqueta ?? textoVacio }}
      </span>
      <img :src="flecha" class="h-3 w-3 shrink-0 opacity-60" alt="" />
    </button>

    <!-- Dibujado acá y no por el sistema: ése es el punto de todo el componente.
         `z-20` porque queda por encima de la cuadrícula, y el borde y el fondo
         salen de los mismos tokens que el resto de la ventana.

         `min-w-64` porque el botón puede vivir en un panel angosto y los nombres
         quedaban cortados en la lista: un desplegable donde no se lee qué dice
         cada opción no sirve de nada. Se pasa de ancho por encima de lo que
         tenga al lado, que es lo que hace cualquier menú. -->
    <div
      v-if="abierto"
      class="absolute z-20 w-full min-w-64 rounded-corner border border-ui-border-strong bg-ui-bg shadow-lg"
      :class="haciaArriba ? 'bottom-full mb-1' : 'mt-1'"
      @keydown.escape.prevent="cerrar()"
      @keydown.down.prevent="mover(1)"
      @keydown.up.prevent="mover(-1)"
      @keydown.home.prevent="((activa = 0), desplazarALaActiva())"
      @keydown.end.prevent="((activa = coincidencias.length - 1), desplazarALaActiva())"
      @keydown.enter.prevent="elegirLaActiva()"
      @keydown.tab="cerrar(false)">
      <div class="border-ui-border border-b p-2">
        <input
          ref="campo"
          v-model="busqueda"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          :aria-controls="idLista"
          :aria-expanded="abierto"
          :aria-activedescendant="coincidencias.length > 0 ? `${idLista}-${activa}` : undefined"
          :placeholder="placeholderBusqueda"
          class="w-full rounded-corner border border-ui-border-strong bg-ui-surface px-2 py-1 text-sm text-tx-main focus:border-primary focus:outline-none" />
      </div>

      <ul :id="idLista" ref="lista" role="listbox" class="max-h-56 overflow-y-auto p-1">
        <li v-if="coincidencias.length === 0" class="p-3 text-center text-tx-muted text-xs">
          {{ textoSinResultados }}
        </li>
        <li
          v-for="(opcion, indice) in coincidencias"
          :id="`${idLista}-${indice}`"
          :key="opcion.valor"
          :data-indice="indice"
          role="option"
          :aria-selected="opcion.valor === modelValue"
          class="flex cursor-pointer items-baseline gap-2 rounded-corner px-2 py-1 text-sm"
          :class="[
            indice === activa ? 'bg-ui-surface' : '',
            opcion.valor === modelValue ? 'font-medium text-primary' : 'text-tx-main',
          ]"
          @click="elegir(opcion.valor)"
          @mousemove="activa = indice">
          <span class="min-w-0 flex-1 truncate">{{ opcion.etiqueta }}</span>
          <span v-if="opcion.detalle" class="shrink-0 text-tx-muted text-xs">
            {{ opcion.detalle }}
          </span>
        </li>
        <!-- Lo que quedó afuera del recorte se dice. Que desaparezcan en silencio
             hace creer que la zona que se busca no existe. -->
        <li v-if="sobrantes > 0" class="px-2 py-1 text-tx-muted text-xs">
          +{{ sobrantes }}
        </li>
      </ul>
    </div>
  </div>
</template>
