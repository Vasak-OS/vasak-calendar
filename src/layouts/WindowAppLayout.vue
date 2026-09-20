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
 * `centro` es el mes entre sus flechas, centrado respecto de la ventana entera
 * y no de lo que sobra entre el icono y los controles: entre columnas se corre
 * lo suficiente como para que se note, porque los tres botones ocupan más que
 * el icono. Con la barra a un costado el centrado cambia de eje solo.
 */
import { WindowFrame } from '@vasakgroup/vue-libvasak';
</script>

<template>
  <WindowFrame>
    <template v-if="$slots.identidad" #identidad><slot name="identidad" /></template>
    <template v-if="$slots.barra" #barra><slot name="barra" /></template>
    <template v-if="$slots.barraCentro" #centro><slot name="barraCentro" /></template>
    <template v-if="$slots.acciones" #acciones><slot name="acciones" /></template>

    <div class="flex min-h-0 min-w-0 flex-1 gap-1 p-1">
      <slot />
    </div>
  </WindowFrame>
</template>
