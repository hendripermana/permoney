# frozen_string_literal: true

# F1-Level Performance: Add missing foreign key indexes
# These indexes will dramatically speed up JOIN queries and foreign key lookups
class AddMissingIndexesForPerformance < ActiveRecord::Migration[8.1]
  disable_ddl_transaction!

  def change
    # Categories
    add_index :categories, :parent_id, algorithm: :concurrently unless index_exists?(:categories, :parent_id)

    # Chats
    add_index :chats, :latest_assistant_response_id, algorithm: :concurrently unless index_exists?(:chats, :latest_assistant_response_id)

    # Families
    add_index :families, :stripe_customer_id, algorithm: :concurrently unless index_exists?(:families, :stripe_customer_id)

    # Entries - CRITICAL for transaction queries
    add_index :entries, :entryable_id, algorithm: :concurrently unless index_exists?(:entries, :entryable_id)
    add_index :entries, :plaid_id, algorithm: :concurrently unless index_exists?(:entries, :plaid_id)

    # Imports
    add_index :imports, :account_id, algorithm: :concurrently unless index_exists?(:imports, :account_id)

    # Messages
    add_index :messages, :provider_id, algorithm: :concurrently unless index_exists?(:messages, :provider_id)

    # Plaid Items
    add_index :plaid_items, :institution_id, algorithm: :concurrently unless index_exists?(:plaid_items, :institution_id)

    # Tool Calls
    add_index :tool_calls, :provider_id, algorithm: :concurrently unless index_exists?(:tool_calls, :provider_id)
    add_index :tool_calls, :provider_call_id, algorithm: :concurrently unless index_exists?(:tool_calls, :provider_call_id)

    # Subscriptions
    add_index :subscriptions, :stripe_id, algorithm: :concurrently unless index_exists?(:subscriptions, :stripe_id)

    # Pay Later Installments
    add_index :pay_later_installments, :transfer_id, algorithm: :concurrently unless index_exists?(:pay_later_installments, :transfer_id)

    # Loans
    add_index :loans, :linked_contact_id, algorithm: :concurrently unless index_exists?(:loans, :linked_contact_id)

    # Loan Installments
    add_index :loan_installments, :transfer_id, algorithm: :concurrently unless index_exists?(:loan_installments, :transfer_id)

    # Lunchflow Items
    add_index :lunchflow_items, :institution_id, algorithm: :concurrently unless index_exists?(:lunchflow_items, :institution_id)
  end
end
