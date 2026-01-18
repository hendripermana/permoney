class AddMetadataToPreciousMetals < ActiveRecord::Migration[8.1]
  def up
    add_column :precious_metals, :account_number, :string unless column_exists?(:precious_metals, :account_number)
    add_column :precious_metals, :account_status, :string, default: "active" unless column_exists?(:precious_metals, :account_status)
    add_column :precious_metals, :scheme_type, :string unless column_exists?(:precious_metals, :scheme_type)
    add_column :precious_metals, :akad, :string unless column_exists?(:precious_metals, :akad)
    add_column :precious_metals, :preferred_funding_account_id, :uuid unless column_exists?(:precious_metals, :preferred_funding_account_id)

    return unless column_exists?(:precious_metals, :preferred_funding_account_id)

    add_foreign_key :precious_metals, :accounts,
                    column: :preferred_funding_account_id,
                    on_delete: :nullify unless foreign_key_exists?(:precious_metals, :accounts, column: :preferred_funding_account_id)
  end

  def down
    remove_foreign_key :precious_metals, column: :preferred_funding_account_id if foreign_key_exists?(:precious_metals, :accounts, column: :preferred_funding_account_id)
    remove_column :precious_metals, :preferred_funding_account_id if column_exists?(:precious_metals, :preferred_funding_account_id)
    remove_column :precious_metals, :akad if column_exists?(:precious_metals, :akad)
    remove_column :precious_metals, :scheme_type if column_exists?(:precious_metals, :scheme_type)
    remove_column :precious_metals, :account_status if column_exists?(:precious_metals, :account_status)
    remove_column :precious_metals, :account_number if column_exists?(:precious_metals, :account_number)
  end
end
