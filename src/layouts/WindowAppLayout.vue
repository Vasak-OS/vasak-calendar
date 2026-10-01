<script lang="ts" setup>
/**
 * La ventana del calendario.
 *
 * No dibuja nada propio: el borde, la esquina, el fondo, la barra y los tres
 * botones salen de `WindowFrame`, que es el mismo de todas las ventanas del
 * escritorio. Estaba copiado acá, y ya había derivado de las copias vecinas.
 *
 * De arriba viene además algo que esta copia no tenía: la barra puede ir
 * arriba, abajo, a la izquierda o a la derecha según `window.barPosition` en
 * `~/.config/vasak/vasak.conf`.
 *
 * Las etiquetas de los tres botones no se pasan: desde la 0.8 los controles las
 * resuelven solos contra `ventana.minimizar`, `ventana.maximizar` y
 * `ventana.cerrar` del catálogo de la aplicación, que son justo las que esto
 * les estaba pasando. Repetirlas acá era dar la misma respuesta dos veces.
 *
 * Las ranuras van tal cual al marco. `barra` es el contenido, que es lo único
 * que crece y donde va el mes entre sus flechas: centrado ahí queda en el medio
 * de lo que sobra entre el icono y los controles, que es donde el ojo lo busca.
 * `centro` sigue significando lo que dice —centrado respecto de la ventana
 * entera— y queda para lo que de verdad lo necesite; acá ya no lo usa nadie.
 */
import { WindowFrame } from '@vasakgroup/vue-libvasak';
import { ref } from 'vue';
import { useNarrowRow } from '@/composables/use-narrow-row';

/**
 * La fila, medida. Las columnas se acomodan solas por la consulta de
 * contenedor, pero la barra queda **fuera** de la fila y no la puede
 * consultar: con la ventana angosta no tiene lugar ni para el título del mes, y
 * quien la llena necesita saberlo para mudarlo. Se lo dice `narrow`, por la
 * ranura.
 */
const row = ref<HTMLElement | null>(null);
const narrow = useNarrowRow(row);
</script>

<template>
  <WindowFrame>
    <template v-if="$slots.identidad" #identidad><slot name="identidad" /></template>
    <template v-if="$slots.barra" #barra><slot name="barra" :narrow="narrow" /></template>
    <template v-if="$slots.barraCentro" #centro><slot name="barraCentro" /></template>
    <template v-if="$slots.acciones" #acciones><slot name="acciones" /></template>

    <!-- La fila es un contenedor con nombre (`row`): con la ventana angosta
         va una columna por vez, y eso lo decide el ancho de la fila, no el de
         la pantalla (ver `tools/narrow-layout.ts`). -->
    <div ref="row" class="@container/row flex min-h-0 min-w-0 flex-1 gap-1 p-1">
      <slot />
    </div>
  </WindowFrame>
</template>
