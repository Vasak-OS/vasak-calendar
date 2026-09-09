# vasak-calendar

El calendario de VasakOS. Muestra los eventos de las cuentas conectadas —las que
se agregan desde Configuración— mes a mes, en una sola cuadrícula.

Tauri 2 + Vue 3 + TypeScript + Tailwind 4, sobre la plantilla
[`vapp`](https://github.com/Vasak-OS/vapp).

---

## Qué hace hoy, y qué no

**Hace:** lista las cuentas que tienen calendarios, descubre los calendarios de
cada una por CalDAV, trae los eventos del mes que se está mirando y los pinta en
el día que corresponde, con el color que la persona le puso a cada calendario en
su servidor.

**Todavía no hace:**

- **Crear ni editar eventos.** Esta versión lee. Escribir por CalDAV es su
  propio trabajo —el `If-Match`, los conflictos con lo que cambió otro cliente,
  las invitaciones— y hacerlo a medias es peor que no hacerlo.
- **Expandir repeticiones.** Un evento con `RRULE` se muestra **una sola vez**,
  el día que empieza, y con una marca (`↻`) que lo dice. Un calendario que
  muestra una reunión el día equivocado es peor que uno que no la muestra, y
  hacer bien las repeticiones —excepciones, fechas que se corren, zonas horarias
  que cambian en el medio— no entra en un incremento.
- **Zonas horarias por evento.** Un `DTSTART` con `TZID` se interpreta como UTC,
  así que puede aparecer corrido de hora. Resolverlo de verdad necesita la base
  de datos de zonas; está anotado en `caldav.rs` como deuda.

---

## De dónde salen las cuentas

De `vasak-accounts`, por D-Bus en el bus del sistema. **Esta aplicación no le
pide la contraseña a nadie**: la cuenta se conecta una vez desde Configuración, y
acá se le pide al servicio la credencial cuando hace falta.

La primera vez que se leen eventos aparece el diálogo de permiso del sistema,
como con cualquier otra aplicación. Listar las cuentas no lo dispara: son
metadatos y el servicio ya acota lo que devuelve a quien pregunta.

### El límite

Esta aplicación pide **`account.calendar` y nada más**. No el correo, que es de
la aplicación de correo; no los contactos, que son de la suya; no los archivos,
que son del gestor de archivos.

Y no es sólo una convención: `vasak-permissions` tiene declarado el alcance para
`/usr/bin/vasak-calendar`, así que un pedido fuera de ahí se niega **sin
siquiera preguntarle a la persona**. Importa más de lo que parece: los contactos
viven en el mismo servidor y detrás de la misma contraseña que los calendarios,
así que sin ese límite la separación entre las dos aplicaciones sería un
`const` que se puede cambiar.

---

## Cómo está armado

| archivo | qué resuelve |
|---|---|
| `src-tauri/src/cuentas.rs` | Habla con `vasak-accounts`: qué cuentas hay y con qué credencial entrar. `Credencial` **no deriva `Debug`** — el secreto se tacha a mano. |
| `src-tauri/src/caldav.rs` | `PROPFIND` para descubrir los calendarios, `REPORT` para traer los eventos, y el parseo de iCalendar. |
| `src-tauri/src/comandos.rs` | Lo que la ventana puede pedir. Junta las dos piezas y devuelve lo que se pudo leer **junto con** lo que falló. |
| `src/tools/mes.ts` | La aritmética de la cuadrícula, sin nada de Vue adentro. |
| `src/composables/use-calendario.ts` | El mes que se mira y lo que hay en él. |

### Por qué un fallo no vacía el mes

Un mes vacío y un mes que no se pudo leer se ven exactamente igual: una
cuadrícula sin nada. La diferencia importa —en uno la persona está libre y en el
otro no tiene idea de qué tiene—, así que lo que falla se muestra al costado, con
el nombre de la cuenta o del calendario adelante. «No se pudo leer» a secas no le
dice a nadie cuál de sus dos cuentas está rota.

### Por qué el parseo de fechas tiene tantos tests

Porque es lo único de un calendario que se equivoca **en silencio**. Una celda
corrida un día se ve perfectamente bien, y la persona se entera cuando llega
tarde a algo. Los casos que ya costaron algo en otro lado están cada uno con su
test: las líneas plegadas a 75 octetos, el `:` dentro de un parámetro entre
comillas, el evento de día completo que termina en la medianoche del día
siguiente, y `new Date('2026-09-15')` — que el motor lee como UTC y en cualquier
zona al oeste de Greenwich devuelve el día anterior.

---

## Desarrollo

```bash
bun install
bun test                                          # el frontend
cargo test --manifest-path src-tauri/Cargo.toml   # el backend
bun run lint
bunx --bun tauri dev
```

Para probar la ventana de verdad hace falta `--features custom-protocol`, o el
webview abre vacío:

```bash
bunx --bun tauri build --debug --features custom-protocol
```

Y hace falta `vasak-accounts` corriendo con al menos una cuenta que tenga
calendarios. Sin eso la aplicación abre igual y lo dice: la lista de cuentas sale
vacía con la explicación de dónde conectar una.
