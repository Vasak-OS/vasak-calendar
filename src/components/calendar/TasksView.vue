<script lang="ts" setup>
/**
 * La vista de tareas: la lista, con crear, editar, completar y borrar.
 *
 * Es la pieza hermana del calendario (M3). Reusa del calendario todo lo que puede
 * —el badge de sincronización (`SyncBadge`), la vista de conflicto
 * (`ConflictDialog`) y el estado de «sin permiso»—, porque una tarea es un objeto
 * del mismo almacén y del mismo área (`calendar`): el único trabajo propio es la
 * lista y su formulario (`TaskDialog`).
 *
 * Es una sola columna, así que con la ventana angosta se ve igual —una lista
 * ocupa el ancho que le den— y no hace falta apilar nada. Cada fila se corta con
 * `truncate` en vez de ensanchar la lista.
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import { ActionButton, Checkbox, EmptyState, ListRow, SwitchRow } from '@vasakgroup/vue-libvasak';
import { computed, onMounted, ref } from 'vue';
import ConflictDialog from '@/components/calendar/ConflictDialog.vue';
import SyncBadge from '@/components/calendar/SyncBadge.vue';
import TaskDialog from '@/components/calendar/TaskDialog.vue';
import type { ConflictChoice } from '@/composables/use-calendario';
import { type Task, useTasks } from '@/composables/use-tasks';
import { formatDue } from '@/tools/task-display';

const props = defineProps<{
	/** La zona de la agenda, compartida con el calendario, para leer el vencimiento. */
	zone: string;
	/**
	 * Vuelve a pedir el permiso del almacén. Es el mismo del calendario (el área es
	 * la misma), así que lo provee el padre en vez de duplicar el flujo. Devuelve la
	 * clave del aviso cuando no se pudo ni reabrir el diálogo, o `null` si se reabrió.
	 */
	reask: () => Promise<string | null>;
}>();

const { t, locale } = useI18n();

const {
	calendars,
	tasks,
	loading,
	notices,
	sinPermiso,
	available,
	includeCompleted,
	cargar,
	setIncludeCompleted,
	writeTask,
	toggleDone,
	deleteTask,
	getConflict,
	resolveConflict,
} = useTasks();

/** Si hay alguna lista donde se pueda crear una tarea. */
const canCreate = computed(() => calendars.value.length > 0);

// ── El formulario de crear / editar / borrar ───────────────────────────────

const dialogOpen = ref(false);
const dialogMode = ref<'create' | 'edit'>('create');
const dialogTask = ref<Task | null>(null);
const dialogError = ref('');
const dialogBusy = ref(false);

function openCreate() {
	dialogMode.value = 'create';
	dialogTask.value = null;
	dialogError.value = '';
	dialogOpen.value = true;
}

function openTask(task: Task) {
	dialogMode.value = 'edit';
	dialogTask.value = task;
	dialogError.value = '';
	dialogOpen.value = true;
}

/** Crea o edita la tarea con lo que armó el formulario; cierra si salió bien. */
async function onSubmit(value: {
	accountId: string;
	calendarId: string;
	payload: Record<string, unknown>;
	ifMatch: string;
}) {
	dialogBusy.value = true;
	dialogError.value = '';
	try {
		const fallo = await writeTask(value.accountId, value.calendarId, value.payload, value.ifMatch);
		if (fallo) {
			dialogError.value = fallo;
			return;
		}
		dialogOpen.value = false;
	} finally {
		dialogBusy.value = false;
	}
}

/** Borra la tarea del formulario; cierra si salió bien. */
async function onDeleteTask(task: Task) {
	dialogBusy.value = true;
	dialogError.value = '';
	try {
		const fallo = await deleteTask(task);
		if (fallo) {
			dialogError.value = isKey(fallo) ? t(fallo) : fallo;
			return;
		}
		dialogOpen.value = false;
	} finally {
		dialogBusy.value = false;
	}
}

// ── Completar desde la casilla de la fila ──────────────────────────────────

/** La casilla de una fila: marca o desmarca la tarea sin abrir el formulario. */
async function onToggle(task: Task, done: boolean) {
	const fallo = await toggleDone(task, done);
	if (fallo) {
		// Lo que falló va arriba de la lista; la casilla ya se restauró sola.
		rowError.value = isKey(fallo) ? t(fallo) : fallo;
	} else {
		rowError.value = '';
	}
}

/** Lo que falló al completar desde una fila, para mostrarlo arriba de la lista. */
const rowError = ref('');

// ── El conflicto, con la misma vista que los eventos ───────────────────────

const conflictOpen = ref(false);
const conflictTask = ref<Task | null>(null);
const conflictError = ref('');
const conflictBusy = ref(false);

/** Deja el formulario de la tarea y abre la comparación del conflicto. */
function openConflict(task: Task) {
	dialogOpen.value = false;
	conflictTask.value = task;
	conflictError.value = '';
	conflictOpen.value = true;
}

/** El objeto que `ConflictDialog` necesita: sólo el id global de la tarea. */
const conflictTarget = computed(() =>
	conflictTask.value ? { uid: conflictTask.value.task_id } : null
);

async function onResolveConflict(choice: ConflictChoice) {
	if (!conflictTask.value) {
		return;
	}
	conflictBusy.value = true;
	conflictError.value = '';
	try {
		const fallo = await resolveConflict(conflictTask.value.task_id, choice);
		if (fallo) {
			conflictError.value = isKey(fallo) ? t(fallo) : fallo;
			return;
		}
		conflictOpen.value = false;
	} finally {
		conflictBusy.value = false;
	}
}

// ── Volver a pedir el permiso ──────────────────────────────────────────────

const pidiendoPermiso = ref(false);
const avisoPermiso = ref('');
async function reclamarPermiso() {
	if (pidiendoPermiso.value) {
		return;
	}
	avisoPermiso.value = '';
	pidiendoPermiso.value = true;
	try {
		const key = await props.reask();
		// Si se reabrió y la persona concedió, esta relectura ya trae las tareas.
		await cargar();
		avisoPermiso.value = key ? t(key) : '';
	} finally {
		pidiendoPermiso.value = false;
	}
}

// ── La fila ────────────────────────────────────────────────────────────────

/** El texto del vencimiento de una tarea, para el dato a la derecha de la fila. */
function dueText(task: Task): string {
	return formatDue(task.due, task.all_day, props.zone, locale.value);
}

/**
 * Una clave de i18n propia (`tareas.*`) y no el texto crudo de un error del
 * programa: lo propio se traduce; lo del programa ya viene listo.
 */
function isKey(value: string): boolean {
	return value.startsWith('tareas.');
}

onMounted(() => {
	void cargar();
});
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
    <!-- Sin permiso para leer el almacén: en vez de una lista vacía, el estado
         que lo dice y el botón que vuelve a abrir el diálogo. -->
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
          <p v-if="avisoPermiso" class="max-w-prose text-body-s text-tx-muted" role="status">
            {{ avisoPermiso }}
          </p>
        </div>
      </EmptyState>
    </div>

    <template v-else>
      <!-- La barra de la vista: ver completadas, y agregar una tarea. -->
      <div class="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
        <SwitchRow
          class="min-w-0 flex-1"
          :model-value="includeCompleted"
          :label="t('tareas.verCompletadas')"
          @update:model-value="setIncludeCompleted" />
        <ActionButton
          v-if="canCreate"
          variant="primary"
          size="sm"
          icon="list-add"
          :label="t('tareas.crear')"
          @click="openCreate()" />
      </div>

      <span v-if="loading" class="shrink-0 text-body-s text-tx-muted" role="status">
        {{ t('tareas.cargando') }}
      </span>

      <!-- Lo que impidió leer algo, o lo que falló al completar una fila. -->
      <p v-if="rowError" class="shrink-0 text-body-s text-tx-muted" role="status">
        {{ rowError }}
      </p>
      <p
        v-for="aviso in notices"
        :key="aviso"
        class="shrink-0 text-body-s text-tx-muted"
        role="status">
        {{ aviso }}
      </p>

      <!-- La lista. Cada fila: la casilla para completar, el título, el
           vencimiento a la derecha y el badge de sincronización. -->
      <div v-if="tasks.length" class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <ul class="flex min-w-0 flex-col gap-1">
          <li v-for="task in tasks" :key="task.task_id" class="min-w-0">
            <ListRow
              role="button"
              truncate
              :title="task.title || t('tareas.sinTitulo')"
              :meta="dueText(task)"
              @click="openTask(task)">
              <template #leading>
                <!-- La casilla no abre el formulario: su clic y su tecla no
                     burbujean a la fila. -->
                <span class="flex" @click.stop @keydown.stop>
                  <Checkbox
                    :model-value="task.done"
                    hide-label
                    :label="t('tareas.completar')"
                    @update:model-value="(done: boolean) => onToggle(task, done)" />
                </span>
              </template>
              <template #trailing>
                <SyncBadge :event="task" />
              </template>
            </ListRow>
          </li>
        </ul>
      </div>

      <!-- Sin tareas: o el almacén no tiene ninguna lista todavía, o la lista no
           tiene nada. -->
      <div v-else class="flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <EmptyState
          v-if="!available"
          icon="x-office-calendar"
          :title="t('tareas.sinListasTitulo')"
          :note="t('tareas.sinListasNota')" />
        <EmptyState
          v-else
          icon="object-select"
          :title="t('tareas.vacioTitulo')"
          :note="includeCompleted ? t('tareas.vacioNota') : t('tareas.vacioPendientesNota')">
          <ActionButton
            v-if="canCreate"
            variant="primary"
            :label="t('tareas.crear')"
            @click="openCreate()" />
        </EmptyState>
      </div>
    </template>

    <!-- El formulario de crear / editar / borrar, flotante dentro de la ventana.
         Fuera del `v-if`/`v-else` para que no se desmonte al recargar la lista. -->
    <TaskDialog
      v-model:open="dialogOpen"
      :mode="dialogMode"
      :calendars="calendars"
      :zone="zone"
      :task="dialogTask"
      :error="dialogError"
      :busy="dialogBusy"
      @submit="onSubmit"
      @delete-task="onDeleteTask"
      @resolve-conflict="openConflict" />

    <!-- La comparación «la mía / la del servidor», la misma que los eventos. -->
    <ConflictDialog
      v-model:open="conflictOpen"
      :event="conflictTarget"
      :load="getConflict"
      :error="conflictError"
      :busy="conflictBusy"
      @resolve="onResolveConflict" />
  </div>
</template>
