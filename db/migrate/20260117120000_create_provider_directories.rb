class CreateProviderDirectories < ActiveRecord::Migration[8.1]
  def change
    create_table :provider_directories, id: :uuid do |t|
      t.references :user, type: :uuid, null: false, foreign_key: true
      t.string :name, null: false
      t.string :kind, null: false, default: "other"
      t.string :country
      t.string :website
      t.text :notes
      t.datetime :archived_at
      t.timestamps
    end

    add_index :provider_directories, "lower(name), user_id",
      unique: true,
      name: "index_provider_directories_on_user_id_and_lower_name"

    add_reference :accounts, :provider, type: :uuid, foreign_key: { to_table: :provider_directories }
  end
end
