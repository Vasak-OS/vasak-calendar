<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { computed, onMounted } from 'vue';
import CuentasComponent from '@/components/calendario/CuentasComponent.vue';
import MesComponent from '@/components/calendario/MesComponent.vue';
import { useCalendario } from '@/composables/use-calendario';
import { useReactiveIcons } from '@/composables/useReactiveIcon';
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

const { anterior, siguiente, actualizar, icono } = useReactiveIcons({
	anterior: 'go-previous',
	siguiente: 'go-next',
	actualizar: 'view-refresh',
	// El icono de la aplicación, no un símbolo: es la identidad de la ventana y
	// va a color, como en el resto del escritorio.
	icono: { name: 'calendar', type: 'icon' },
});

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
    <template #barra>
      <!-- El icono de la aplicación, a la izquierda de todo, como en el resto
           del escritorio. -->
      <img :src="icono" class="h-6 w-6 shrink-0" :alt="t('app.nombre')" />

      <!-- Lo que sigue se va contra los controles de la ventana, que es donde
           está el botón de actualizar en el resto de las aplicaciones. -->
      <span class="flex-1"></span>

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
        <img :src="actualizar" class="h-6 w-6" alt="" />
      </button>
    </template>

    <!-- Centrado en la barra entera, no en lo que sobra entre el icono y los
         controles de la ventana. -->
    <template #barraCentro>
      <!-- El mes **entre** las flechas, que es donde la gente las busca: la de
           ir atrás a la izquierda de lo que se está mirando y la de ir adelante
           a la derecha. -->
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="rounded-corner p-1 hover:bg-ui-surface"
          :aria-label="t('calendario.mesAnterior')"
          @click="mesAnterior()">
          <img :src="anterior" class="h-5 w-5" alt="" />
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
          <img :src="siguiente" class="h-5 w-5" alt="" />
        </button>
      </div>

      <button
        type="button"
        class="rounded-corner border border-ui-border-strong px-2 py-0.5 text-sm hover:bg-ui-surface"
        @click="irAHoy()">
        {{ t('calendario.hoy') }}
      </button>
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
