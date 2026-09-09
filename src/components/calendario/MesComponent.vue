<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { computed } from 'vue';
import { claveSegunCantidad, interpolar } from '@/tools/interpolar';
import { claveDe, type Dia, type Evento } from '@/tools/mes';

const props = defineProps<{
	dias: Dia[];
	eventosDe: (fecha: Date) => Evento[];
}>();

const { t, locale } = useI18n();

/**
 * Cuántos eventos entran en una celda antes de resumir.
 *
 * Tres y no «los que quepan»: una celda que crece con su contenido hace que la
 * fila entera crezca, y un día con doce reuniones aplastaría a los otros seis de
 * su semana hasta dejarlos ilegibles. Lo que no entra se cuenta.
 */
const VISIBLES = 3;

/**
 * Los nombres de los días y de los meses salen de `Intl`, no del catálogo.
 *
 * Traducirlos a mano sería mantener doce meses y siete días por idioma para algo
 * que el sistema ya sabe hacer —y hacerlo mejor: sabe de mayúsculas, de
 * abreviaturas y de idiomas que no escribimos nosotros. El catálogo se queda con
 * lo que es de esta aplicación.
 */
const nombresDeDias = computed(() => {
	const formato = new Intl.DateTimeFormat(locale.value, { weekday: 'short' });
	const largo = new Intl.DateTimeFormat(locale.value, { weekday: 'long' });
	// Un lunes cualquiera como origen: el 5 de enero de 2026 lo es.
	return Array.from({ length: 7 }, (_, i) => {
		const dia = new Date(2026, 0, 5 + i);
		return { corto: formato.format(dia), largo: largo.format(dia) };
	});
});

const formatoDeHora = computed(
	() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' })
);

const formatoDeDia = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'full' }));

/** Las seis filas de siete días. */
const semanas = computed(() => {
	const filas: Dia[][] = [];
	for (let i = 0; i < props.dias.length; i += 7) {
		filas.push(props.dias.slice(i, i + 7));
	}
	return filas;
});

function visiblesDe(dia: Dia): Evento[] {
	return props.eventosDe(dia.fecha).slice(0, VISIBLES);
}

function sobrantesDe(dia: Dia): number {
	return Math.max(0, props.eventosDe(dia.fecha).length - VISIBLES);
}

function tituloDe(evento: Evento): string {
	return evento.titulo.trim() || t('calendario.sinTitulo');
}

/** La hora de un evento, o «todo el día» si no tiene. */
function horaDe(evento: Evento): string {
	if (evento.todo_el_dia) {
		return t('calendario.todoElDia');
	}
	return formatoDeHora.value.format(new Date(evento.inicio));
}

/**
 * Lo que lee un lector de pantalla al pararse en un evento.
 *
 * La hora y el título juntos: el color dice de qué calendario es, y un color no
 * se lee.
 */
function descripcionDe(evento: Evento): string {
	return interpolar(t('calendario.eventosDelDia'), horaDe(evento), tituloDe(evento));
}

function resumenSobrantes(cantidad: number): string {
	return interpolar(t(claveSegunCantidad('calendario.masEventos', cantidad)), cantidad);
}
</script>

<template>
  <!-- Una cuadrícula de verdad y no un montón de divs: con `grid`, `row` y
       `gridcell`, un lector de pantalla dice «martes 15 de septiembre, columna
       2» en vez de leer 42 cosas sueltas sin relación entre sí.

       Lo que **todavía no** hace es moverse con las flechas: eso pide un
       `tabindex` móvil y sus manejadores de teclado, y no está escrito. Se
       recorre con Tab como cualquier otra cosa. -->
  <div class="flex min-h-0 flex-1 flex-col" role="grid" :aria-label="t('app.nombre')">
    <div class="grid grid-cols-7 border-ui-border border-b" role="row">
      <!-- Abreviado a la vista y entero para quien escucha: «lun» leído en voz
           alta no es una palabra. -->
      <div
        v-for="dia in nombresDeDias"
        :key="dia.largo"
        class="px-2 py-1 text-center font-medium text-tx-muted text-xs uppercase"
        role="columnheader"
        :aria-label="dia.largo">
        <span aria-hidden="true">{{ dia.corto }}</span>
      </div>
    </div>

    <!-- `rowgroup` y no un div pelado: una `grid` tiene que ser dueña de sus
         filas, y un elemento sin rol en el medio las desprende del árbol de
         accesibilidad. Las filas quedaban ahí pero la cuadrícula no las
         reconocía como suyas. -->
    <div class="grid min-h-0 flex-1 grid-rows-6" role="rowgroup">
      <div
        v-for="(semana, indice) in semanas"
        :key="indice"
        class="grid grid-cols-7"
        role="row">
        <div
          v-for="dia in semana"
          :key="claveDe(dia.fecha)"
          class="flex min-h-0 flex-col gap-0.5 overflow-hidden border-ui-border border-r border-b p-1 last:border-r-0"
          :class="{
            // Los días del mes anterior y del siguiente se ven, porque son días
            // reales con eventos reales, pero apagados: si pesaran igual, no se
            // distinguiría dónde empieza el mes que se está mirando.
            'bg-ui-surface/20': !dia.delMes,
          }"
          role="gridcell"
          :aria-label="formatoDeDia.format(dia.fecha)">
          <div class="flex items-center justify-between">
            <span
              class="flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm tabular-nums"
              :class="[
                dia.esHoy ? 'bg-primary font-semibold text-tx-on-primary' : '',
                dia.delMes ? 'text-tx-main' : 'text-tx-muted',
              ]">
              {{ dia.fecha.getDate() }}
            </span>
          </div>

          <ul class="flex min-h-0 flex-col gap-0.5 overflow-hidden">
            <li
              v-for="evento in visiblesDe(dia)"
              :key="`${evento.uid}-${evento.inicio}`"
              class="flex items-center gap-1 truncate rounded-corner-sm bg-ui-surface/60 px-1 py-0.5 text-xs"
              :title="descripcionDe(evento)">
              <!-- El color del calendario, como una marca al costado y no como
                   fondo del evento: de fondo, un color cualquiera del servidor
                   puede dejar el texto ilegible, y no hay forma de saber de
                   antemano si es claro u oscuro. -->
              <span
                class="h-3 w-1 shrink-0 rounded-full"
                :style="{ backgroundColor: evento.color ?? 'var(--color-primary)' }"
                aria-hidden="true"></span>
              <span class="sr-only">{{ descripcionDe(evento) }}</span>
              <span class="shrink-0 text-tx-muted tabular-nums" aria-hidden="true">
                {{ evento.todo_el_dia ? '' : horaDe(evento) }}
              </span>
              <span class="truncate" aria-hidden="true">{{ tituloDe(evento) }}</span>
              <!-- Que se repite se dice, porque esta versión lo muestra una sola
                   vez: sin la marca, una reunión semanal parece única y las
                   demás semanas parecen libres. -->
              <span
                v-if="evento.se_repite"
                class="shrink-0 text-tx-muted"
                :title="`${t('calendario.seRepite')} — ${t('calendario.seRepiteDetalle')}`"
                :aria-label="t('calendario.seRepite')">↻</span>
            </li>
            <li v-if="sobrantesDe(dia) > 0" class="px-1 text-tx-muted text-xs">
              {{ resumenSobrantes(sobrantesDe(dia)) }}
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
