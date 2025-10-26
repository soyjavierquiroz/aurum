export default {
  up: async (knex) => {
    // aurum_conversations
    const hasConversations = await knex.schema.hasTable('aurum_conversations');
    if (!hasConversations) {
      await knex.schema.createTable('aurum_conversations', (t) => {
        t.integer('user_id').notNullable();
        t.string('telefono', 32).notNullable();
        t.string('instancia_evolution_api', 64).notNullable();
        t.string('dominio', 128).notNullable();
        t.dateTime('last_activity_at').nullable();
        t.dateTime('last_ping_at').nullable();
        t.integer('window_msg_count').notNullable().defaultTo(0);
        t.string('timezone_effective', 64).nullable();
        t.text('working_window').nullable(); // JSON como texto (MySQL 5.7 ok)
        t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
        t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());

        t.primary(['user_id', 'telefono', 'instancia_evolution_api', 'dominio']);
        t.index(['user_id', 'telefono']);
      });
    }

    // aurum_user_settings
    const hasUserSettings = await knex.schema.hasTable('aurum_user_settings');
    if (!hasUserSettings) {
      await knex.schema.createTable('aurum_user_settings', (t) => {
        t.integer('user_id').primary().notNullable();
        t.string('PING_URL', 512).nullable();
        t.string('REMINDER_URL', 512).nullable();
        t.string('timezone_default', 64).nullable();
        t.text('working_window_default').nullable();
        t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
        t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());
      });
    }

    // aurum_followups_queue
    const hasQueue = await knex.schema.hasTable('aurum_followups_queue');
    if (!hasQueue) {
      await knex.schema.createTable('aurum_followups_queue', (t) => {
        t.bigIncrements('id').primary();
        t.integer('user_id').notNullable();
        t.string('telefono', 32).notNullable();
        t.string('instancia_evolution_api', 64).notNullable();
        t.string('dominio', 128).notNullable();

        t.string('kind', 64).notNullable(); // reminder_1d, reminder_customXd, etc.
        t.dateTime('scheduled_at').notNullable();
        t.string('status', 32).notNullable().defaultTo('scheduled'); // scheduled|cancelled|done|failed
        t.boolean('cancel_on_new_ping').notNullable().defaultTo(true);

        t.string('trace_id', 64).nullable();
        t.string('generation_id', 64).nullable();
        t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
        t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());

        t.index(['user_id', 'telefono', 'instancia_evolution_api', 'dominio'], 'idx_afq_conv');
        t.index(['scheduled_at', 'status'], 'idx_afq_sched_status');
      });
    }

    // aurum_status_catalog
    const hasStatus = await knex.schema.hasTable('aurum_status_catalog');
    if (!hasStatus) {
      await knex.schema.createTable('aurum_status_catalog', (t) => {
        t.integer('user_id').notNullable();
        t.string('status_key', 64).notNullable();
        t.string('label', 191).notNullable();
        t.boolean('is_active').notNullable().defaultTo(true);
        t.integer('sort_order').notNullable().defaultTo(0);
        t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
        t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());
        t.primary(['user_id', 'status_key']);
        t.index(['user_id', 'sort_order']);
      });
    }

    // aurum_operational_status_catalog
    const hasOpStatus = await knex.schema.hasTable('aurum_operational_status_catalog');
    if (!hasOpStatus) {
      await knex.schema.createTable('aurum_operational_status_catalog', (t) => {
        t.string('status_key', 64).primary().notNullable();
        t.string('label', 191).notNullable();
        t.string('description', 512).nullable();
        t.boolean('is_active').notNullable().defaultTo(true);
        t.integer('sort_order').notNullable().defaultTo(0);
      });
    }

    // aurum_lead_state
    const hasLeadState = await knex.schema.hasTable('aurum_lead_state');
    if (!hasLeadState) {
      await knex.schema.createTable('aurum_lead_state', (t) => {
        t.integer('user_id').notNullable();
        t.string('telefono', 32).notNullable();
        t.string('instancia_evolution_api', 64).notNullable();
        t.string('dominio', 128).notNullable();

        t.string('business_status_key', 64).nullable();     // FK (user_id, status_key)
        t.string('operational_status_key', 64).nullable();  // FK -> aurum_operational_status_catalog.status_key
        t.string('reason_code', 64).nullable();
        t.string('note', 512).nullable();
        t.dateTime('paused_until').nullable();
        t.dateTime('effective_at').notNullable().defaultTo(knex.fn.now());
        t.string('source', 64).nullable();
        t.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
        t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now());

        t.primary(['user_id', 'telefono', 'instancia_evolution_api', 'dominio']);
        t.index(['user_id', 'telefono', 'instancia_evolution_api', 'dominio'], 'idx_als_conv');
        t.index(['effective_at'], 'idx_als_effective');

        // Nota: MySQL 5.7 permite FK compuestas, pero para MVP mantenemos índices + validación de app.
      });
    }
  }
};
