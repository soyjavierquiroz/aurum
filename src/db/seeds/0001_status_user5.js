export default {
  run: async (knex) => {
    await knex.raw(`
      INSERT IGNORE INTO aurum_status_catalog (user_id, status_key, label) VALUES
      (5, 'curioso', '🟡 Curioso'),
      (5, 'interesado_basico', '🟠 Interesado básico'),
      (5, 'interesado_avanzado', '🟣 Interesado avanzado'),
      (5, 'reserva_iniciada', '🔵 Reserva iniciada'),
      (5, 'adelanto_pagado', '🟢 Adelanto pagado'),
      (5, 'inscrito_final', '⚪ Inscrito final'),
      (5, 'espera_llamada', '⏳ Espera llamada'),
      (5, 'visita_agendada', '📍 Visita agendada'),
      (5, 'perdido', '🔴 Perdido');
    `);
  }
};
