class RemoveEffectiveClassificationFromAccounts < ActiveRecord::Migration[7.2]
  def up
    # Drop triggers and functions if they exist
    execute "DROP TRIGGER IF EXISTS update_accounts_effective_classification_from_pl ON personal_lendings;"
    execute "DROP FUNCTION IF EXISTS trg_update_accounts_effective_classification_from_pl();"
    execute "DROP TRIGGER IF EXISTS set_accounts_effective_classification ON accounts;"
    execute "DROP FUNCTION IF EXISTS trg_set_accounts_effective_classification();"
    execute "DROP FUNCTION IF EXISTS compute_effective_classification(accounts);"

    # Remove the denormalized column
    if column_exists?(:accounts, :effective_classification)
      remove_column :accounts, :effective_classification
    end
  end

  def down
    # No-op: we intentionally retire the denormalized column and triggers.
    # If needed, reintroduce via the previous migration.
  end
end

