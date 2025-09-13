class CreateAuditLogs < ActiveRecord::Migration[7.2]
  def change
    create_table :audit_logs, id: :uuid, default: -> { "gen_random_uuid()" } do |t|
      t.string  :auditable_type, null: false
      t.uuid    :auditable_id,   null: false
      t.string  :event,          null: false, default: "update"
      t.jsonb   :changeset,      null: false, default: {}
      t.uuid    :user_id
      t.string  :ip_address
      t.datetime :created_at,    null: false, default: -> { "CURRENT_TIMESTAMP" }

      t.index [ :auditable_type, :auditable_id ]
      t.index [ :event ]
      t.index [ :user_id ]
    end
  end
end
