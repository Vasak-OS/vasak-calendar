<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ActionButton, ThemeIcon } from '@vasakgroup/vue-libvasak';
import { computed, onMounted } from 'vue';
import AccountsPanel from '@/components/calendar/AccountsPanel.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import { useCalendario } from '@/composables/use-calendario';
import WindowAppLayout from '@/layouts/WindowAppLayout.vue';

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
    <template #barra>
      <div class="m-auto flex min-w-0 items-center gap-2">
        <!-- El mes **entre** las flechas, que es donde la gente las busca: la de
             ir atrás a la izquierda de lo que se está mirando y la de ir adelante
             a la derecha. -->
        <div class="flex min-w-0 items-center gap-1">
          <ActionButton
            variant="ghost"
            label=""
            icon="go-previous"
            :icon-alt="t('calendario.mesAnterior')"
            @click="mesAnterior()" />
          <!-- `aria-live` para que al cambiar de mes se anuncie: el título es lo
               único que dice dónde quedó la cuadrícula, y quien no la ve no tiene
               otra pista. -->
          <!-- `first-letter` y no `capitalize`: lo segundo sube **cada** palabra
               y el título salía «Septiembre De 2026». En español sólo va la
               primera, y el nombre del mes lo escribe `Intl` en minúscula. -->
          <!-- `w-44` y no `min-w-44`: el mismo ancho fijo para que las flechas no
               se muevan al cambiar de mes, pero que ceda —recortado— cuando la
               barra no tiene lugar, en vez de empujar las flechas fuera. -->
          <h1
            class="w-44 min-w-0 truncate text-center font-title text-base first-letter:uppercase"
            aria-live="polite">
            {{ title }}
          </h1>
          <ActionButton
            variant="ghost"
            label=""
            icon="go-next"
            :icon-alt="t('calendario.mesSiguiente')"
            @click="mesSiguiente()" />
        </div>

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
      :accounts="cuentas"
      :calendars="calendarios"
      :notices="avisos"
      :zone="zona"
      :chosen-zone="zonaElegida"
      :system-zone="zonaDelSistema"
      :foreign-zone="zonaAjena"
      @choose-zone="elegirZona" />
    <MonthGrid :days="dias" :zone="zona" :events-of="eventsOf" />
  </WindowAppLayout>
</template>
