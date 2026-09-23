<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ThemeIcon } from '@vasakgroup/vue-libvasak';
import { computed, onMounted } from 'vue';
import CuentasComponent from '@/components/calendario/CuentasComponent.vue';
import MesComponent from '@/components/calendario/MesComponent.vue';
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
	eventosDe,
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
const titulo = computed(() =>
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
      <button
        type="button"
        class="rounded-corner border border-ui-border bg-ui-bg/80 p-1 hover:bg-ui-surface disabled:opacity-50"
        :aria-label="t('calendario.actualizar')"
        :title="t('calendario.actualizar')"
        :disabled="cargando"
        @click="cargar()">
        <ThemeIcon name="view-refresh" type="symbol" :size="24" />
      </button>
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
      <div class="m-auto flex items-center gap-2">
        <!-- El mes **entre** las flechas, que es donde la gente las busca: la de
             ir atrás a la izquierda de lo que se está mirando y la de ir adelante
             a la derecha. -->
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="rounded-corner p-1 hover:bg-ui-surface"
            :aria-label="t('calendario.mesAnterior')"
            @click="mesAnterior()">
            <ThemeIcon name="go-previous" type="symbol" :size="20" />
          </button>
          <!-- `aria-live` para que al cambiar de mes se anuncie: el título es lo
               único que dice dónde quedó la cuadrícula, y quien no la ve no tiene
               otra pista. -->
          <!-- `first-letter` y no `capitalize`: lo segundo sube **cada** palabra
               y el título salía «Septiembre De 2026». En español sólo va la
               primera, y el nombre del mes lo escribe `Intl` en minúscula. -->
          <h1
            class="min-w-44 text-center font-title text-base first-letter:uppercase"
            aria-live="polite">
            {{ titulo }}
          </h1>
          <button
            type="button"
            class="rounded-corner p-1 hover:bg-ui-surface"
            :aria-label="t('calendario.mesSiguiente')"
            @click="mesSiguiente()">
            <ThemeIcon name="go-next" type="symbol" :size="20" />
          </button>
        </div>

        <button
          type="button"
          class="rounded-corner border border-ui-border-strong px-2 py-0.5 text-sm hover:bg-ui-surface"
          @click="irAHoy()">
          {{ t('calendario.hoy') }}
        </button>
      </div>
    </template>

    <!-- Las secciones separadas por aire y no por líneas: cada una es una
         superficie redondeada, como los paneles del escritorio. -->
    <CuentasComponent
      :cuentas="cuentas"
      :calendarios="calendarios"
      :avisos="avisos"
      :zona="zona"
      :zona-elegida="zonaElegida"
      :zona-del-sistema="zonaDelSistema"
      :zona-ajena="zonaAjena"
      @elegir-zona="elegirZona" />
    <MesComponent :dias="dias" :zona="zona" :eventos-de="eventosDe" />
  </WindowAppLayout>
</template>
