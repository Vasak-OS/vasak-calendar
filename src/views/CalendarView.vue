<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ActionButton, ThemeIcon } from '@vasakgroup/vue-libvasak';
import { computed, nextTick, onMounted, ref } from 'vue';
import AccountsPanel from '@/components/calendar/AccountsPanel.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import MonthNavigation from '@/components/calendar/MonthNavigation.vue';
import { useCalendario } from '@/composables/use-calendario';
import WindowAppLayout from '@/layouts/WindowAppLayout.vue';
import { NARROW_ONLY, type Pane, paneClass } from '@/tools/narrow-layout';

const { t, locale } = useI18n();
const {
	mes,
	zona,
	zonaElegida,
	zonaDelSistema,
	zonaAjena,
	elegirZona,
	dias,
	cuentas,
	calendarios,
	cargando,
	avisos,
	eventsOf,
	cargar,
	mesAnterior,
	mesSiguiente,
	irAHoy,
} = useCalendario();

/**
 * «septiembre de 2026», en el idioma de la sesión y sin traducirlo a mano.
 *
 * Con `timeZone`: el mes se guarda como el instante de su día 1, y ese instante
 * leído en la zona del sistema puede caer el último día del mes anterior. Sin
 * esto, mirar la agenda en una zona al este y el título decía el mes equivocado.
 */
const title = computed(() =>
	new Intl.DateTimeFormat(locale.value, {
		month: 'long',
		year: 'numeric',
		timeZone: zona.value,
	}).format(mes.value)
);

/**
 * La columna que se mira con la ventana angosta (`tools/narrow-layout.ts`).
 * Se arranca por el mes, que es lo que se viene a ver; las cuentas quedan un
 * paso atrás.
 */
const pane = ref<Pane>('month');

/**
 * Pasa a otra columna y le lleva el foco a su botón de ir o volver: la que se
 * deja se oculta, y un foco en algo oculto se pierde. Con la ventana ancha ese
 * botón no se muestra y el foco se queda donde estaba.
 */
async function go(next: Pane) {
	pane.value = next;
	await nextTick();
	// El marcador va en el envoltorio del botón y no en el botón: con las
	// plantillas estrictas, un atributo que el componente no declara no compila.
	const target = document.querySelector<HTMLElement>(`[data-nav="${next}"] button`);
	target?.focus();
}

onMounted(cargar);
</script>

<template>
  <WindowAppLayout>
    <!-- El icono de la aplicación, a la izquierda de todo, como en el resto
         del escritorio. Va en `identidad` y no en la ranura del contenido:
         cuando la barra queda a un costado, es la única parte que no se
         desplaza con lo demás. -->
    <template #identidad>
      <!-- El icono de la aplicación, no un símbolo: es la identidad de la
           ventana y va a color, como en el resto del escritorio. `icon` es lo
           que `ThemeIcon` trae por omisión. -->
      <ThemeIcon name="calendar" :size="24" :alt="t('app.nombre')" />
    </template>

    <!-- El estado y el botón de actualizar, junto a los botones de la ventana,
         que es donde están en el resto de las aplicaciones. El hueco que los
         empujaba hasta ahí —un `span` con `flex-1`— lo pone la barra sola. -->
    <template #acciones>
      <!-- El estado de carga se dice, no se insinúa con un icono girando: sin
           esto, un servidor lento y un mes vacío se ven igual. -->
      <span v-if="cargando" class="text-tx-muted text-xs" role="status">
        {{ t('calendario.cargando') }}
      </span>
      <!-- `ghost`, como los tres botones de la ventana que tiene al lado: los
           cuatro son controles de la barra y se leen como un grupo. -->
      <ActionButton
        variant="ghost"
        label=""
        icon="view-refresh"
        :icon-alt="t('calendario.actualizar')"
        :title="t('calendario.actualizar')"
        :disabled="cargando"
        @click="cargar()" />
    </template>

    <!-- **Centrado en el hueco que queda**, no en la ventana entera. Va en el
         contenido de la barra —la única ranura que crece— con `m-auto`, que en
         un contenedor flexible reparte lo que sobra a los dos lados. Estaba en
         `centro`, que centra respecto de la ventana: con el icono de un lado y
         el estado, el botón de actualizar y los tres controles del otro, el
         medio de la ventana no es el medio del hueco, y el grupo quedaba
         corrido a la derecha con la mitad izquierda de la barra vacía.

         `m-auto` y no `mx-auto` porque la barra también puede ir a un costado:
         ahí el eje del hueco es el vertical, y el margen automático en los dos
         ejes centra en el que corresponda sin preguntar cuál es.

         El mes y «Hoy» van dentro del mismo envoltorio, así que lo que se
         centra es el conjunto: son una sola cosa para el ojo, y centrar el mes
         solo dejaría al botón colgando de un lado. -->
    <template #barra="{ narrow }">
      <!-- Con la ventana angosta la barra no tiene lugar ni para el título: a
           240 px el mes y sus flechas desaparecían y «Hoy» quedaba encima de la
           flecha. Ahí se mudan a la tira de arriba del mes, y la barra se queda
           con el icono, actualizar y los tres botones de la ventana. -->
      <div v-if="!narrow" class="m-auto flex min-w-0 items-center gap-2">
        <MonthNavigation :title="title" @previous="mesAnterior()" @next="mesSiguiente()" />

        <!-- `shrink-0`: en una barra angosta cede el título del mes, que se
             recorta, y no «Hoy», que partido en letras no se lee. -->
        <ActionButton
          variant="secondary"
          size="sm"
          class="shrink-0"
          :label="t('calendario.hoy')"
          @click="irAHoy()" />
      </div>
    </template>

    <!-- Las secciones separadas por aire y no por líneas: cada una es una
         superficie redondeada, como los paneles del escritorio. -->
    <AccountsPanel
      :class="paneClass('accounts', pane)"
      :accounts="cuentas"
      :calendars="calendarios"
      :notices="avisos"
      :zone="zona"
      :chosen-zone="zonaElegida"
      :system-zone="zonaDelSistema"
      :foreign-zone="zonaAjena"
      @choose-zone="elegirZona"
      @forward="go('month')" />

    <!-- El mes con su botón para ir a las cuentas, que sólo existe con la
         ventana angosta. Con la ventana ancha el envoltorio no se nota: la
         cuadrícula lo llena entero, como antes. -->
    <div
      data-pane="month"
      class="flex min-h-0 min-w-0 flex-1 flex-col gap-1"
      :class="paneClass('month', pane)">
      <!-- La tira de la ventana angosta: el botón de las cuentas, «Hoy» y el
           mes entre sus flechas, que en la barra ya no entran. En dos renglones
           mientras la fila no da para uno —a 240 px el título se cortaría—, y
           en uno desde 22 rem, con el mes en el medio como en la barra. -->
      <div class="@container/strip shrink-0" :class="NARROW_ONLY">
        <div
          class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1">
          <div class="col-start-1 row-start-1 flex" data-nav="month">
            <ActionButton
              variant="ghost"
              size="sm"
              icon="go-previous"
              icon-type="symbol"
              :label="t('nav.accounts')"
              @click="go('accounts')" />
          </div>
          <ActionButton
            variant="secondary"
            size="sm"
            class="col-start-3 row-start-1"
            :label="t('calendario.hoy')"
            @click="irAHoy()" />
          <MonthNavigation
            fluid
            class="col-span-3 row-start-2 @min-[22rem]/strip:col-span-1 @min-[22rem]/strip:col-start-2 @min-[22rem]/strip:row-start-1"
            :title="title"
            @previous="mesAnterior()"
            @next="mesSiguiente()" />
        </div>
      </div>
      <MonthGrid :days="dias" :zone="zona" :events-of="eventsOf" />
    </div>
  </WindowAppLayout>
</template>
