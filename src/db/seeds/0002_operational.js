export default {
  run: async (knex) => {
    await knex.raw(`
      INSERT IGNORE INTO aurum_operational_status_catalog (status_key, label, description) VALUES
      ('contactable', 'Contactable', 'Lead activo en seguimiento'),
      ('paused', 'Pausado', 'Pausado temporalmente (usado con paused_until)'),
      ('opt_out', 'Baja voluntaria', 'No desea más contacto'),
      ('won', 'Ganado', 'Venta cerrada / Inscripción final'),
      ('discarded', 'Descartado', 'No califica'),
      ('stopped', 'Detenido', 'Corte manual/política'),
      ('invalid', 'Inválido', 'Teléfono erróneo/spam');
    `);
  }
};
