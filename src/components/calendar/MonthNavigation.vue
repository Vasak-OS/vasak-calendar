<script lang="ts" setup>
/**
 * El mes entre sus dos flechas.
 *
 * Va en dos lugares: en la barra de la ventana, como siempre, y con la ventana
 * angosta en la tira de arriba del mes, porque ahí la barra no tiene lugar ni
 * para el título (ver `tools/narrow-layout.ts`). Es la misma pieza en los dos,
 * para que no se separen.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ActionButton } from '@vasakgroup/vue-libvasak';

withDefaults(
	defineProps<{
		/** «septiembre de 2026», ya escrito en el idioma de la sesión. */
		title: string;
		/**
		 * `false` en la barra: el título tiene un ancho fijo para que las flechas
		 * no se muevan al cambiar de mes. `true` en la tira angosta, donde ocupa
		 * lo que quede y no hay otra cosa que se pueda mover.
		 */
		fluid?: boolean;
	}>(),
	{ fluid: false }
);

const emit = defineEmits<{
	previous: [];
	next: [];
}>();

const { t } = useI18n();
</script>

<template>
  <!-- El mes **entre** las flechas, que es donde la gente las busca: la de ir
       atrás a la izquierda de lo que se está mirando y la de ir adelante a la
       derecha. -->
  <div class="flex min-w-0 items-center gap-1">
    <ActionButton
      variant="ghost"
      label=""
      icon="go-previous"
      :icon-alt="t('calendario.mesAnterior')"
      @click="emit('previous')" />
    <!-- `aria-live` para que al cambiar de mes se anuncie: el título es lo
         único que dice dónde quedó la cuadrícula, y quien no la ve no tiene
         otra pista.

         `first-letter` y no `capitalize`: lo segundo sube **cada** palabra y
         el título salía «Septiembre De 2026». En español sólo va la primera, y
         el nombre del mes lo escribe `Intl` en minúscula.

         En la barra, `w-44` y no `min-w-44`: el mismo ancho fijo para que las
         flechas no se muevan al cambiar de mes, pero que ceda —recortado—
         cuando la barra no tiene lugar, en vez de empujar las flechas fuera. -->
    <h1
      class="min-w-0 truncate text-center font-title text-base first-letter:uppercase"
      :class="fluid ? 'flex-1' : 'w-44'"
      aria-live="polite">
      {{ title }}
    </h1>
    <ActionButton
      variant="ghost"
      label=""
      icon="go-next"
      :icon-alt="t('calendario.mesSiguiente')"
      @click="emit('next')" />
  </div>
</template>
