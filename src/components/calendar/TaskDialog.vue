<script lang="ts" setup>
/**
 * El formulario de crear, editar y borrar una tarea (`VTODO`).
 *
 * Es el espejo de `EventDialog.vue` para una tarea: un diálogo flotante dentro de
 * la ventana —superficie opaca `ui-float`, que pone `DialogContent`—, con el
 * estilo de Once UI que traen los componentes de `vue-libvasak`. No dibuja
 * controles propios. La lógica de armar el parche y de validar vive en
 * `tools/task-form.ts`, probada aparte; acá queda juntar lo que escribe la
 * persona y mostrar lo que falta.
 *
 * ── Editar exige el ETag; un conflicto se resuelve antes de editar ────────────
 *
 * Igual que un evento (decisión 3): editar una tarea exige su ETag como
 * `if_match`. El almacén lo entrega por fila, así que editar se enciende cuando la
 * tarea lo tiene. Una tarea recién creada sin confirmar todavía no lo tiene: sigue
 * en pausa —se puede ver y borrar, no editar— y se muestra como **pendiente**. Una
 * tarea **en conflicto** no se edita: primero se resuelve con «mantener la mía /
 * tomar la del servidor», que esta ventana ofrece con un aviso no destructivo (el
 * botón abre la vista comparativa, reusando la de los eventos).
 */
import { useI18n } from '@vasakgroup/tauri-plugin-i18n';
import {
	ActionButton,
	AlertMessage,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	FormGroup,
	SelectField,
	type SelectOption,
	SwitchRow,
	TextArea,
	TextInput,
} from '@vasakgroup/vue-libvasak';
import { computed, reactive, ref, watch } from 'vue';
import type { Calendario } from '@/composables/use-calendario';
import type { Task } from '@/composables/use-tasks';
import { isoToDatePicker, isoToDateTimePicker } from '@/tools/ical-date';
import { canEdit, isConflict } from '@/tools/sync-state';
import {
	buildCreateTask,
	buildEditTask,
	priorityFromNumber,
	statusFromString,
	TASK_PRIORITIES,
	TASK_STATUSES,
	type TaskFormState,
	type TaskPriority,
	type TaskStatus,
} from '@/tools/task-form';

const props = withDefaults(
	defineProps<{
		open: boolean;
		mode: 'create' | 'edit';
		/** Las listas donde se puede guardar una tarea. */
		calendars: Calendario[];
		/** La zona de la agenda, con la que se arma el vencimiento. */
		zone: string;
		/** La tarea que se está editando o borrando, en modo `edit`. */
		task?: Task | null;
		/** El mensaje de un fallo al escribir, ya traducido, que decide el padre. */
		error?: string;
		/** Mientras la escritura está en curso: desactiva los botones. */
		busy?: boolean;
	}>(),
	{ task: null, error: '', busy: false }
);

const emit = defineEmits<{
	'update:open': [open: boolean];
	/**
	 * Crear o editar: el parche armado, a dónde mandarlo y el `ifMatch` (vacío al
	 * crear; el ETag de la tarea al editar, para la precondición).
	 */
	submit: [
		value: {
			accountId: string;
			calendarId: string;
			payload: Record<string, unknown>;
			ifMatch: string;
		},
	];
	/** Borrar la tarea que se está viendo. */
	'delete-task': [task: Task];
	/** Abrir la vista comparativa para resolver el conflicto de la tarea. */
	'resolve-conflict': [task: Task];
}>();

const { t } = useI18n();

/** Lo que junta el formulario. Reactivo para que los campos lo escriban. */
const form = reactive<TaskFormState>({
	summary: '',
	calendar: '',
	description: '',
	hasDue: false,
	allDay: false,
	due: '',
	status: 'NEEDS-ACTION',
	priority: 'none',
});

/** Lo que falta, como clave de i18n. Se limpia al abrir. */
const localError = ref('');

/** Si está pidiendo confirmación para borrar. */
const confirmingDelete = ref(false);

/** Las opciones del desplegable de listas: su nombre, su id global. */
const calendarOptions = computed<SelectOption<string>[]>(() =>
	props.calendars.map((c) => ({ label: c.nombre, value: c.url }))
);

/** Las opciones de estado, con su etiqueta traducida. */
const statusOptions = computed<SelectOption<TaskStatus>[]>(() =>
	TASK_STATUSES.map((status) => ({ label: t(`tareas.estado.${status}`), value: status }))
);

/** Las opciones de prioridad, con su etiqueta traducida. */
const priorityOptions = computed<SelectOption<TaskPriority>[]>(() =>
	TASK_PRIORITIES.map((priority) => ({ label: t(`tareas.prioridad.${priority}`), value: priority }))
);

/** Si la tarea que se está viendo está en conflicto con el servidor. */
const taskInConflict = computed(
	() => props.mode === 'edit' && !!props.task && isConflict(props.task)
);

/**
 * Se puede guardar al crear siempre; al editar, sólo si la tarea tiene ETag y no
 * está en conflicto. Un conflicto se resuelve antes de editar.
 */
const canSave = computed(
	() => props.mode === 'create' || (canEdit(props.task) && !taskInConflict.value)
);

/**
 * Por qué no se puede editar todavía, como clave de i18n, o vacío si sí se puede.
 * Una tarea sin ETag está pendiente de sincronizar; una en conflicto se resuelve
 * primero (tiene su propio aviso).
 */
const pendingNote = computed(() => {
	if (props.mode !== 'edit' || canSave.value || taskInConflict.value) {
		return '';
	}
	return 'tareas.pendiente';
});

/** El título del diálogo según para qué se abrió. */
const title = computed(() =>
	props.mode === 'create' ? t('tareas.tituloCrear') : t('tareas.tituloEditar')
);

// Al abrirse, arranca el formulario: en blanco para crear, o con lo que trae la
// tarea para ver/editar.
watch(
	() => [props.open, props.task, props.mode] as const,
	([open]) => {
		if (!open) {
			return;
		}
		localError.value = '';
		confirmingDelete.value = false;
		if (props.mode === 'edit' && props.task) {
			fillFrom(props.task);
		} else {
			fillBlank();
		}
	},
	{ immediate: true }
);

/** Arranca el formulario vacío, sin vencimiento. */
function fillBlank() {
	form.summary = '';
	form.calendar = props.calendars[0]?.url ?? '';
	form.description = '';
	form.hasDue = false;
	form.allDay = false;
	form.due = '';
	form.status = 'NEEDS-ACTION';
	form.priority = 'none';
}

/** Carga lo que se sabe de la tarea. La descripción no viaja con la lista, así que queda en blanco (edición conservadora: lo que la vista no cargó no se pisa). */
function fillFrom(task: Task) {
	form.summary = task.title;
	form.calendar = task.calendar_id;
	form.description = '';
	form.status = statusFromString(task.status);
	form.priority = priorityFromNumber(task.priority);
	form.allDay = task.all_day;
	if (task.due) {
		form.hasDue = true;
		form.due = task.all_day
			? isoToDatePicker(task.due, true, props.zone)
			: isoToDateTimePicker(task.due, props.zone);
	} else {
		form.hasDue = false;
		form.due = '';
	}
}

/**
 * Al prender el vencimiento sin fecha puesta, se arranca en hoy; al cambiar entre
 * todo-el-día y con hora, se recorta o completa el valor para que no quede a medio
 * formato cuando cambia el tipo de `<input>`.
 */
watch(
	() => [form.hasDue, form.allDay] as const,
	([hasDue, allDay], [, antesAllDay]) => {
		if (hasDue && !form.due) {
			const day = today();
			form.due = allDay ? day : `${day}T09:00`;
			return;
		}
		if (hasDue && allDay !== antesAllDay) {
			form.due = convertValue(form.due, allDay);
		}
	}
);

/** `AAAA-MM-DDTHH:MM` ⇄ `AAAA-MM-DD` según si pasa a todo-el-día. */
function convertValue(value: string, toAllDay: boolean): string {
	const day = value.slice(0, 10);
	if (toAllDay) {
		return day;
	}
	return value.includes('T') ? value : `${day}T09:00`;
}

/** Hoy, `AAAA-MM-DD`, en la zona de la agenda. */
function today(): string {
	return isoToDatePicker(new Date().toISOString(), false, props.zone);
}

function close() {
	emit('update:open', false);
}

/**
 * Valida y, si está bien, emite el parche. Al crear arma el parche sin `id` y
 * manda `ifMatch` vacío; al editar lo arma con el `id` de la tarea y manda su ETag
 * como `ifMatch`.
 */
function onSave() {
	localError.value = '';
	const result =
		props.mode === 'edit' && props.task
			? buildEditTask(form, props.zone, props.task.task_id)
			: buildCreateTask(form, props.zone);
	if (!result.ok) {
		localError.value = t(result.error);
		return;
	}
	emit('submit', {
		accountId: result.accountId,
		calendarId: result.calendarId,
		payload: result.patch,
		ifMatch: props.mode === 'edit' ? (props.task?.etag ?? '') : '',
	});
}

function onDelete() {
	if (props.task) {
		emit('delete-task', props.task);
	}
}

/** Abre la vista comparativa para resolver el conflicto de la tarea. */
function onResolve() {
	if (props.task) {
		emit('resolve-conflict', props.task);
	}
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent size="lg">
      <DialogHeader closable>
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>

      <DialogBody>
        <div class="flex flex-col gap-4">
          <!-- En conflicto: un aviso no destructivo que no toca la tarea, con el
               botón que abre la comparación «la mía / la del servidor». -->
          <AlertMessage
            v-if="taskInConflict"
            tone="warning"
            icon="auto"
            :title="t('conflicto.tituloTarea')">
            {{ t('conflicto.descripcionTarea') }}
            <template #actions>
              <ActionButton
                variant="secondary"
                size="sm"
                :label="t('conflicto.resolver')"
                :disabled="busy"
                @click="onResolve" />
            </template>
          </AlertMessage>

          <FormGroup :label="t('tareas.titulo')" v-slot="{ id }">
            <TextInput
              :id="id"
              v-model="form.summary"
              :placeholder="t('tareas.tituloPlaceholder')"
              :disabled="busy" />
          </FormGroup>

          <FormGroup :label="t('tareas.lista')" v-slot="{ id }">
            <SelectField
              :id="id"
              v-model="form.calendar"
              :options="calendarOptions"
              :disabled="busy || mode === 'edit'" />
          </FormGroup>

          <!-- Estado y prioridad, uno al lado del otro cuando el diálogo da el
               ancho y apilados cuando no: el envoltorio es un contenedor. -->
          <div class="@container">
            <div class="grid grid-cols-1 gap-4 @sm:grid-cols-2">
              <FormGroup :label="t('tareas.estadoLabel')" v-slot="{ id }">
                <SelectField
                  :id="id"
                  v-model="form.status"
                  :options="statusOptions"
                  :disabled="busy" />
              </FormGroup>
              <FormGroup :label="t('tareas.prioridadLabel')" v-slot="{ id }">
                <SelectField
                  :id="id"
                  v-model="form.priority"
                  :options="priorityOptions"
                  :disabled="busy" />
              </FormGroup>
            </div>
          </div>

          <SwitchRow
            v-model="form.hasDue"
            :label="t('tareas.conVencimiento')"
            :disabled="busy" />

          <!-- El vencimiento, sólo si la tarea lo tiene. -->
          <template v-if="form.hasDue">
            <SwitchRow
              v-model="form.allDay"
              :label="t('tareas.todoElDia')"
              :disabled="busy" />
            <FormGroup :label="t('tareas.vencimiento')" v-slot="{ id }">
              <TextInput
                :id="id"
                v-model="form.due"
                :type="form.allDay ? 'date' : 'datetime-local'"
                :disabled="busy" />
            </FormGroup>
          </template>

          <FormGroup :label="t('tareas.descripcion')" v-slot="{ id }">
            <TextArea :id="id" v-model="form.description" :rows="3" :disabled="busy" />
          </FormGroup>

          <!-- Lo que falta (validación) o lo que falló al escribir (del padre),
               anunciado para el lector de pantalla. -->
          <p
            v-if="localError || error"
            class="text-body-s text-tx-muted"
            role="status">
            {{ localError || error }}
          </p>

          <!-- Una tarea sin ETag está pendiente de sincronizar y no se puede
               editar todavía: se dice, para que «Guardar» apagado no parezca un
               error. Un conflicto tiene su propio aviso arriba. -->
          <p v-if="pendingNote" class="text-body-s text-tx-muted" role="note">
            {{ t(pendingNote) }}
          </p>
        </div>
      </DialogBody>

      <DialogFooter>
        <!-- Borrar, con una confirmación en el mismo pie: un clic lo pide, el
             segundo lo hace. -->
        <template v-if="mode === 'edit'">
          <template v-if="confirmingDelete">
            <ActionButton
              variant="secondary"
              :label="t('tareas.cancelar')"
              :disabled="busy"
              @click="confirmingDelete = false" />
            <ActionButton
              variant="danger"
              :label="t('tareas.borrarConfirmar')"
              :loading="busy"
              @click="onDelete" />
          </template>
          <template v-else>
            <ActionButton
              variant="danger"
              icon="user-trash"
              :label="t('tareas.borrar')"
              :disabled="busy"
              @click="confirmingDelete = true" />
            <ActionButton
              variant="primary"
              :label="t('tareas.guardar')"
              :disabled="busy || !canSave"
              @click="onSave" />
          </template>
        </template>
        <template v-else>
          <ActionButton
            variant="secondary"
            :label="t('tareas.cancelar')"
            :disabled="busy"
            @click="close" />
          <ActionButton
            variant="primary"
            :label="t('tareas.guardar')"
            :loading="busy"
            @click="onSave" />
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
