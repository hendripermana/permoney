class AddInstitutionFieldsToAccounts < ActiveRecord::Migration[8.1]
  def change
    add_column :accounts, :institution_name, :string
    add_column :accounts, :institution_domain, :string
    add_column :accounts, :notes, :text

    # Touch all accounts to invalidate cached queries that depend on accounts.maximum(:updated_at).
    reversible do |dir|
      dir.up { execute("UPDATE accounts SET updated_at = CURRENT_TIMESTAMP") }
    end
  end
end
