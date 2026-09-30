# Respuestas de CalDAV grabadas

Para las pruebas de `src/caldav.rs` que miran si el servidor respetó el
`<c:expand>` de la consulta (RFC 4791 §9.6.5).

- `radicale-3.8.1-expand.xml` y `radicale-3.8.1-plain.xml` son **grabadas**:
  un Radicale 3.8.1 corriendo en local, con `weekly.ics` (una reunión semanal
  en `Europe/Madrid` que cruza el cambio de hora del 25/10/2026, con un
  `EXDATE`, una instancia movida y una cancelada), un cumpleaños anual de día
  completo y un evento suelto. La consulta es `expand-query.xml`, que es
  exactamente lo que arma `events_query(…, true)`; la otra, lo mismo con
  `<c:calendar-data/>`. La respuesta sin `expand` es también lo que devuelve
  un servidor que **ignora** el pedido: no avisa, manda el evento con su regla.
- `nextcloud-32-expand.xml` está **armada a mano** siguiendo lo que hace
  SabreDAV (`VCalendar::expand` de sabre/vobject 4.5): prefijos `d:`/`cal:`,
  el `getetag` con `&quot;`, los finales de línea como `&#13;`, las zonas
  pasadas a UTC, el `RECURRENCE-ID` en cada instancia —también en la primera—
  y la cancelada conservada con su `STATUS:CANCELLED`, igual que Radicale.
