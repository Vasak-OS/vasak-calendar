<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ActionButton, EmptyState, ThemeIcon } from '@vasakgroup/vue-libvasak';
import { computed, nextTick, onMounted, ref } from 'vue';
import AccountsPanel from '@/components/calendar/AccountsPanel.vue';
import ColumnsView from '@/components/calendar/ColumnsView.vue';
import MonthAgenda from '@/components/calendar/MonthAgenda.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import MonthNavigation from '@/components/calendar/MonthNavigation.vue';
import ViewSwitcher from '@/components/calendar/ViewSwitcher.vue';
import YearView from '@/components/calendar/YearView.vue';
import { useCalendario } from '@/composables/use-calendario';
import WindowAppLayout from '@/layouts/WindowAppLayout.vue';
import { NARROW_ONLY, type Pane, paneClass, WIDE_ONLY } from '@/tools/narrow-layout';
import { periodTitle } from '@/tools/views';
import { civilDe } from '@/tools/zona';

const { t, locale } = useI18n();
const {
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
	cargando,
	avisos,
	sinPermiso,
	eventsOf,
	cargar,
	refresh,
	pedirPermisoDeNuevo,
	syncStatuses,
	refreshFailures,
	goPrevious,
	goNext,
	goToToday,
} = useCalendario();

/**
 * El botón de «volver a pedir el permiso»: mientras pide se desactiva —no es
 * instantáneo y dos clics seguidos chocan con el techo de uno por minuto— y, si
 * no se pudo ni reabrir el diálogo, deja debajo el motivo traducido (el techo, o
 * un recurso ajeno). Si se reabrió, `pedirPermisoDeNuevo` ya releyó: o aparece
 * el calendario, o vuelve el mismo estado porque la persona dijo que no de nuevo.
 */
const pidiendoPermiso = ref(false);
const avisoPermiso = ref('');
async function reclamarPermiso() {
	if (pidiendoPermiso.value) {
		return;
	}
	avisoPermiso.value = '';
	pidiendoPermiso.value = true;
	try {
		const key = await pedirPermisoDeNuevo();
		avisoPermiso.value = key ? t(key) : '';
	} finally {
		pidiendoPermiso.value = false;
	}
}

/**
 * El título del período que se está mirando —el mes, el día, la semana, el
 * año—, en el idioma de la sesión y en la zona de la agenda (`tools/views.ts`).
 */
const title = computed(() =>
	periodTitle(view.value, anchor.value, dias.value, zona.value, locale.value)
);

/**
 * Qué dicen las flechas según la vista. En el mes hablan de meses —y así lo
 * dejan las claves de siempre—; en las demás vistas son genéricas, porque lo
 * que mueven cambia (un día, una semana, un año).
 */
const navLabels = computed(() =>
	view.value === 'month' ? {} : { previousLabel: t('nav.previous'), nextLabel: t('nav.next') }
);

/** El año que mira la vista de año: el de `anchor`, en la zona de la agenda. */
const yearNumber = computed(() => civilDe(anchor.value, zona.value).anio);

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
	const target = document.querySelector<HTMLElement>(`[data-nav="${next}"] button`);
	target?.focus();
}

/**
 * Las listas que se pueden llevar al día de hoy: el mes como agenda —con la
 * ventana angosta— y la vista de agenda. Las dos son `MonthAgenda`, y sólo una
 * existe por vez según la vista.
 */
const monthAgenda = ref<InstanceType<typeof MonthAgenda> | null>(null);
const agendaView = ref<InstanceType<typeof MonthAgenda> | null>(null);

/** Lleva la lista al día de hoy, en las vistas que son una lista. */
function scrollListToToday() {
	monthAgenda.value?.showToday();
	agendaView.value?.showToday();
}

/**
 * «Hoy»: lleva el foco al día de hoy y, en las vistas de lista, la deja en él.
 *
 * Después de cargar y de que se dibuje: el día de hoy y sus eventos llegan con
 * la carga, y la lista no está hasta que la vista se volvió a dibujar.
 */
async function onToday() {
	await goToToday();
	await nextTick();
	scrollListToToday();
}

onMounted(async () => {
	await cargar();
	// Se abre en hoy: con la ventana angosta —o en la agenda— la lista arranca
	// en el día de hoy y no en el primero del mes, como en un teléfono.
	await nextTick();
	scrollListToToday();
});
</script>

<template>
  <WindowAppLayout>
    <!-- El icono de la aplicación, a la izquierda de todo, como en el resto del
         escritorio. Va en `identidad`: cuando la barra queda a un costado, es la
         única parte que no se desplaza con lo demás. -->
    <template #identidad>
      <ThemeIcon name="calendar" :size="24" :alt="t('app.nombre')" />
    </template>

    <!-- El estado y el botón de actualizar, junto a los botones de la ventana. -->
    <template #acciones>
      <span v-if="cargando" class="text-tx-muted text-xs" role="status">
        {{ t('calendario.cargando') }}
      </span>
      <ActionButton
        variant="ghost"
        label=""
        icon="view-refresh"
        :icon-alt="t('calendario.actualizar')"
        :title="t('calendario.actualizar')"
        :disabled="cargando"
        @click="refresh()" />
    </template>

    <!-- El título del período entre sus flechas, centrado en el hueco de la
         barra. Con la ventana angosta no hay lugar ni para el título: se muda a
         la tira de arriba de la vista (ver abajo) y la barra se queda con el
         icono, actualizar y los tres controles de la ventana. -->
    <template #barra="{ narrow }">
      <div v-if="!narrow" class="m-auto flex min-w-0 items-center gap-2">
        <MonthNavigation
          :title="title"
          v-bind="navLabels"
          @previous="goPrevious()"
          @next="goNext()" />
        <ActionButton
          variant="secondary"
          size="sm"
          class="shrink-0"
          :label="t('calendario.hoy')"
          @click="onToday()" />
      </div>
    </template>

    <!-- Sin permiso para leer el almacén, el calendario queda vacío y sin
         salida: en vez de la cuadrícula y el panel vacíos, un estado que lo dice
         y el botón que vuelve a abrir el diálogo. Ocupa la fila entera, así que
         con la ventana angosta se ve igual —una sola cosa centrada—. -->
    <div v-if="sinPermiso" class="flex min-h-0 min-w-0 flex-1 items-center justify-center">
      <EmptyState
        icon="dialog-password"
        :title="t('permiso.titulo')"
        :note="t('permiso.descripcion')">
        <div class="flex min-w-0 flex-col items-center gap-2">
          <ActionButton
            variant="primary"
            :label="t('permiso.pedir')"
            :loading="pidiendoPermiso"
            @click="reclamarPermiso" />
          <!-- El motivo de que no se pudiera ni reabrir el diálogo —el techo, un
               recurso ajeno—, debajo del botón y anunciado para el lector de
               pantalla. -->
          <p v-if="avisoPermiso" class="max-w-prose text-body-s text-tx-muted" role="status">
            {{ avisoPermiso }}
          </p>
        </div>
      </EmptyState>
    </div>

    <!-- Las secciones separadas por aire: cada una es una superficie redondeada. -->
    <template v-else>
    <AccountsPanel
      :class="paneClass('accounts', pane)"
      :accounts="cuentas"
      :calendars="calendarios"
      :notices="avisos"
      :sync-statuses="syncStatuses"
      :refresh-failures="refreshFailures"
      :zone="zona"
      :chosen-zone="zonaElegida"
      :system-zone="zonaDelSistema"
      :foreign-zone="zonaAjena"
      @choose-zone="elegirZona"
      @forward="go('month')" />

    <!-- La columna principal: el selector de vista arriba, y debajo la vista
         elegida. Con la ventana ancha el envoltorio no se nota; con la angosta
         lleva además la tira con el botón de las cuentas, «Hoy» y el período. -->
    <div
      data-pane="month"
      class="flex min-h-0 min-w-0 flex-1 flex-col gap-1"
      :class="paneClass('month', pane)">
      <!-- El selector de vista, con cualquier ancho. -->
      <div class="shrink-0">
        <ViewSwitcher :model-value="view" @change="setView" />
      </div>

      <!-- La tira de la ventana angosta: el botón de las cuentas, «Hoy» y el
           período entre sus flechas, que en la barra ya no entran. En dos
           renglones mientras la fila no da para uno, y en uno desde 22 rem. -->
      <div class="@container/strip shrink-0" :class="NARROW_ONLY">
        <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1">
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
            @click="onToday()" />
          <MonthNavigation
            fluid
            v-bind="navLabels"
            class="col-span-3 row-start-2 @min-[22rem]/strip:col-span-1 @min-[22rem]/strip:col-start-2 @min-[22rem]/strip:row-start-1"
            :title="title"
            @previous="goPrevious()"
            @next="goNext()" />
        </div>
      </div>

      <!-- La vista elegida. El mes muestra la cuadrícula con la ventana ancha y
           la agenda con la angosta (siete columnas de 30 px cortan los eventos);
           las demás vistas se acomodan solas a cualquier ancho. -->
      <template v-if="view === 'month'">
        <MonthGrid :class="WIDE_ONLY" :days="dias" :zone="zona" :events-of="eventsOf" />
        <MonthAgenda
          ref="monthAgenda"
          :class="NARROW_ONLY"
          :days="dias"
          :zone="zona"
          :events-of="eventsOf" />
      </template>
      <ColumnsView
        v-else-if="view === 'day' || view === 'days' || view === 'week'"
        :days="dias"
        :zone="zona"
        :events-of="eventsOf" />
      <YearView
        v-else-if="view === 'year'"
        :year="yearNumber"
        :zone="zona"
        :events-of="eventsOf"
        @select-day="(fecha) => show(fecha, 'day')"
        @select-month="(fecha) => show(fecha, 'month')" />
      <!-- La agenda como vista propia es la misma lista del mes angosto
           (`MonthAgenda`), ahora con cualquier ancho. -->
      <MonthAgenda
        v-else
        ref="agendaView"
        :days="dias"
        :zone="zona"
        :events-of="eventsOf" />
    </div>
    </template>
  </WindowAppLayout>
</template>
