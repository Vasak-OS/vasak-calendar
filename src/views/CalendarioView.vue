<script lang="ts" setup>
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { computed, onMounted } from 'vue';
import CuentasComponent from '@/components/calendario/CuentasComponent.vue';
import MesComponent from '@/components/calendario/MesComponent.vue';
import ZonaComponent from '@/components/calendario/ZonaComponent.vue';
import { useCalendario } from '@/composables/use-calendario';
import { useReactiveIcons } from '@/composables/useReactiveIcon';
import { interpolar } from '@/tools/interpolar';

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

const { anterior, siguiente } = useReactiveIcons({
	anterior: 'go-previous',
	siguiente: 'go-next',
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
  <div class="flex min-h-0 flex-1 flex-col">
    <header class="flex items-center gap-2 border-ui-border border-b px-3 py-2">
      <button
        type="button"
        class="rounded-corner p-1 hover:bg-ui-surface"
        :aria-label="t('calendario.mesAnterior')"
        @click="mesAnterior()">
        <img :src="anterior" class="h-5 w-5" alt="" />
      </button>
      <button
        type="button"
        class="rounded-corner p-1 hover:bg-ui-surface"
        :aria-label="t('calendario.mesSiguiente')"
        @click="mesSiguiente()">
        <img :src="siguiente" class="h-5 w-5" alt="" />
      </button>
      <!-- `aria-live` para que al cambiar de mes se anuncie: el título es lo
           único que dice dónde quedó la cuadrícula, y quien no la ve no tiene
           otra pista. -->
      <h1 class="font-title text-lg capitalize" aria-live="polite">{{ titulo }}</h1>
      <button
        type="button"
        class="rounded-corner border border-ui-border-strong px-2 py-0.5 text-sm hover:bg-ui-surface"
        @click="irAHoy()">
        {{ t('calendario.hoy') }}
      </button>

      <!-- Que la agenda no está en la hora de acá se dice en la cabecera, no en
           un menú: quien fijó una zona para viajar se olvida, y una agenda que
           muestra horas de otro país sin avisar se lee mal sin que nada lo
           delate. -->
      <span
        v-if="zonaAjena"
        class="rounded-corner bg-ui-surface px-2 py-0.5 text-tx-muted text-xs"
        role="status">
        {{ interpolar(t('calendario.viendoEn'), zona.replace(/_/g, ' ')) }}
      </span>

      <span class="flex-1"></span>

      <ZonaComponent
        :elegida="zonaElegida"
        :del-sistema="zonaDelSistema"
        @elegir="elegirZona" />

      <!-- El estado de carga se dice, no se insinúa con un icono girando: sin
           esto, un servidor lento y un mes vacío se ven igual. -->
      <span v-if="cargando" class="text-tx-muted text-xs" role="status">
        {{ t('calendario.cargando') }}
      </span>
      <button
        v-else
        type="button"
        class="rounded-corner px-2 py-0.5 text-sm text-tx-muted hover:bg-ui-surface"
        @click="cargar()">
        {{ t('calendario.actualizar') }}
      </button>
    </header>

    <div class="flex min-h-0 flex-1">
      <CuentasComponent :cuentas="cuentas" :calendarios="calendarios" :avisos="avisos" />
      <MesComponent :dias="dias" :zona="zona" :eventos-de="eventosDe" />
    </div>
  </div>
</template>
