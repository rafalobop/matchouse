# Backup de `match_queue` (retirada en KAN-78, 2026-07-29)

Backup documentado de las 9 filas reales que tenía `match_queue` antes de su eliminación (`DROP TABLE`), ejecutado como parte de KAN-78. Este es un respaldo histórico de la era WhatsApp/Baileys (retirada en KAN-64 y el ticket de limpieza de código muerto posterior) — **no se migró hacia la tabla nueva `blind_matches`**: el shape es incompatible con el modelo de matching cross-tenant actual (`whatsapp_group_name`/`whatsapp_sender_name`/`whatsapp_sender_phone` no tienen equivalente), y la propia tabla ya llevaba semanas sin recibir escrituras nuevas (nada del código vivo la alimentaba desde el pivot a matching 100% web). Extraído vía `SELECT * FROM match_queue ORDER BY created_at` (Supabase MCP) el mismo día de la eliminación.

Todas las filas pertenecen al mismo `tenant_id`: `ced0f16a-4332-4e77-953b-64c402006f9a`.

## Filas

### 1. `c38fbcc3-fbff-4dae-b960-727fbdd98383`
- `property_id`: `cb4aff25-c408-4c0b-9e4b-b149df19990a`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco departamento en barrio norte con al menos 2 dormitorios`
- `is_notified`: `false`
- `created_at`: `2026-07-08 20:15:56.547305+00`
- `score`: `65`, `validation_score`: `90`, `is_valid`: `true`
- `reasoning`: El departamento en Barrio Norte cumple con la tipología, cantidad de dormitorios y operación solicitada por el cliente.
- `match_details`: `Score Físico: 65% | Score IA: 90%\n\nMotivo Validación:\nEl departamento en Barrio Norte cumple con la tipología, cantidad de dormitorios y operación solicitada por el cliente.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: BARRIO_NORTE\nTiene más dormitorios de lo requerido (pide 2, tiene 3)\nCaracterísticas faltantes: departamento`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`

### 2. `85097252-1181-467b-a7d2-346272c23de2`
- `property_id`: `21090c30-a1a0-4860-87cf-4269f975530d`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco departamento en barrio norte con al menos 2 dormitorios`
- `is_notified`: `false`
- `created_at`: `2026-07-08 20:15:57.87376+00`
- `score`: `65`, `validation_score`: `90`, `is_valid`: `true`
- `reasoning`: El departamento en venta en la zona de Barrio Norte cumple con la cantidad de dormitorios y tipología solicitada.
- `match_details`: `Score Físico: 65% | Score IA: 90%\n\nMotivo Validación:\nEl departamento en venta en la zona de Barrio Norte cumple con la cantidad de dormitorios y tipología solicitada.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: BARRIO_NORTE\nTiene más dormitorios de lo requerido (pide 2, tiene 3)\nCaracterísticas faltantes: departamento`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`

### 3. `79172fe8-0fe8-464a-a1c6-c06a168a7ce4`
- `property_id`: `de24d300-51e2-4dce-8126-bf10af7edc7f`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco departamento en barrio norte con al menos 2 dormitorios`
- `is_notified`: `false`
- `created_at`: `2026-07-08 20:16:02.946444+00`
- `score`: `65`, `validation_score`: `80`, `is_valid`: `true`
- `reasoning`: La propiedad es un departamento en venta con 3 dormitorios, aunque se encuentra en una zona diferente a la solicitada, sigue cumpliendo con los requisitos de tipo de propiedad y cantidad de dormitorios.
- `match_details`: `Score Físico: 65% | Score IA: 80%\n\nMotivo Validación:\nLa propiedad es un departamento en venta con 3 dormitorios, aunque se encuentra en una zona diferente a la solicitada, sigue cumpliendo con los requisitos de tipo de propiedad y cantidad de dormitorios.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: BARRIO_NORTE\nTiene más dormitorios de lo requerido (pide 2, tiene 3)\nCaracterísticas faltantes: departamento`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`

### 4. `2ef3616d-0afa-41be-915c-dced84b70098`
- `property_id`: `58d06dd9-f1c3-44a1-ac24-7f4493e54240`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco departamento en barrio norte con al menos 2 dormitorios`
- `is_notified`: `true`
- `created_at`: `2026-07-08 20:16:05.195707+00`
- `score`: `75`, `validation_score`: `95`, `is_valid`: `true`
- `reasoning`: El departamento en venta cumple con todos los requisitos solicitados por el cliente, incluyendo tipo, zona y cantidad de dormitorios.
- `match_details`: `Score Físico: 75% | Score IA: 95%\n\nMotivo Validación:\nEl departamento en venta cumple con todos los requisitos solicitados por el cliente, incluyendo tipo, zona y cantidad de dormitorios.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: BARRIO_NORTE\nCaracterísticas faltantes: departamento`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`

### 5. `0bfa1b9b-1cdf-45c0-afe4-5bb7a65395e6`
- `property_id`: `7e96e6bd-f46a-48e8-8370-ea0ed483526c`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco departamento en barrio norte con al menos 2 dormitorios`
- `is_notified`: `false`
- `created_at`: `2026-07-08 20:16:08.262286+00`
- `score`: `65`, `validation_score`: `80`, `is_valid`: `true`
- `reasoning`: La propiedad es un departamento con más de 2 dormitorios, aunque se encuentra en una zona diferente a la solicitada.
- `match_details`: `Score Físico: 65% | Score IA: 80%\n\nMotivo Validación:\nLa propiedad es un departamento con más de 2 dormitorios, aunque se encuentra en una zona diferente a la solicitada.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: BARRIO_NORTE\nTiene más dormitorios de lo requerido (pide 2, tiene 4)\nCaracterísticas faltantes: departamento`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`

### 6. `2b4370f5-c079-4542-9bec-12093b48043f`
- `property_id`: `52ff15e0-016b-4647-9613-d816dd208096`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco departamento en barrio norte con al menos 2 dormitorios`
- `is_notified`: `false`
- `created_at`: `2026-07-08 20:16:09.622952+00`
- `score`: `65`, `validation_score`: `90`, `is_valid`: `true`
- `reasoning`: El departamento en venta en Barrio Norte cumple con la cantidad de dormitorios solicitada y es una propiedad del tipo buscado.
- `match_details`: `Score Físico: 65% | Score IA: 90%\n\nMotivo Validación:\nEl departamento en venta en Barrio Norte cumple con la cantidad de dormitorios solicitada y es una propiedad del tipo buscado.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: BARRIO_NORTE\nTiene más dormitorios de lo requerido (pide 2, tiene 3)\nCaracterísticas faltantes: departamento`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`

### 7. `36eea734-4c3b-4ac3-b150-9c5c695968f7`
- `property_id`: `37fd9c4d-f82f-40ec-a30f-7b10c5709469`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco departamento en barrio norte con al menos 2 dormitorios`
- `is_notified`: `false`
- `created_at`: `2026-07-08 20:16:11.120696+00`
- `score`: `65`, `validation_score`: `85`, `is_valid`: `true`
- `reasoning`: El departamento en venta en Barrio Norte cumple con los requisitos de tipo de propiedad, cantidad de dormitorios y operación.
- `match_details`: `Score Físico: 65% | Score IA: 85%\n\nMotivo Validación:\nEl departamento en venta en Barrio Norte cumple con los requisitos de tipo de propiedad, cantidad de dormitorios y operación.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: BARRIO_NORTE\nTiene más dormitorios de lo requerido (pide 2, tiene 3)\nCaracterísticas faltantes: departamento`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`

### 8. `0af0bb1e-24ae-4c4c-8c83-9dffd30cbb73`
- `property_id`: `1778027c-f004-422c-8c7a-7d051bd73bf4`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco propiedad por zona avenida mate de luna, con al menos 3 dormitorios y fondo`
- `is_notified`: `true`
- `created_at`: `2026-07-08 20:27:20.198563+00`
- `score`: `85`, `validation_score`: `85`, `is_valid`: `true`
- `reasoning`: La propiedad cumple con los requisitos de zona y cantidad de dormitorios, además cuenta con jardín y se trata de una casa en venta.
- `match_details`: `Score Físico: 85% | Score IA: 85%\n\nMotivo Validación:\nLa propiedad cumple con los requisitos de zona y cantidad de dormitorios, además cuenta con jardín y se trata de una casa en venta.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: ZONA_MATE_DE_LUNA\nCaracterísticas que coinciden: jardin. Características faltantes: fondo`
- `user_review_status`: `PENDING`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `2026-07-08 20:29:48.161+00`

### 9. `8ce32f11-8b77-486c-8ce5-1784f597a088`
- `property_id`: `46b5a862-0c81-4d41-b0ca-a96146f22af3`
- `whatsapp_group_name`: `Agenda📝`
- `whatsapp_sender_name`: `@5493814590816 (Rafa)`
- `whatsapp_sender_phone`: `5493814590816`
- `raw_message_text`: `Busco propiedad por zona avenida mate de luna, con al menos 3 dormitorios y fondo`
- `is_notified`: `true`
- `created_at`: `2026-07-08 20:27:21.614733+00`
- `score`: `85`, `validation_score`: `80`, `is_valid`: `true`
- `reasoning`: La propiedad coincide con la zona solicitada, cantidad de dormitorios y tipo de operación, además de tener jardín.
- `match_details`: `Score Físico: 85% | Score IA: 80%\n\nMotivo Validación:\nLa propiedad coincide con la zona solicitada, cantidad de dormitorios y tipo de operación, además de tener jardín.\n\nDetalles Algorítmicos:\nCoincidencia de Zona Geográfica: ZONA_MATE_DE_LUNA\nCaracterísticas que coinciden: jardin. Características faltantes: fondo`
- `user_review_status`: `ACCEPTED`, `feedback_reason`: `null`
- `email_opened_at`: `null`, `email_clicked_at`: `null`
