# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[7.2].define(version: 2025_09_07_120000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pgcrypto"
  enable_extension "plpgsql"

  # Custom types defined in this database.
  # Note that some types may not work with other database engines. Be careful if changing database.
  create_enum "account_status", ["ok", "syncing", "error"]

  create_table "accounts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "subtype"
    t.uuid "family_id", null: false
    t.string "name"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "accountable_type"
    t.uuid "accountable_id"
    t.decimal "balance", precision: 19, scale: 4
    t.string "currency"
    t.virtual "classification", type: :string, as: "\nCASE\n    WHEN ((accountable_type)::text = ANY (ARRAY[('Loan'::character varying)::text, ('CreditCard'::character varying)::text, ('OtherLiability'::character varying)::text])) THEN 'liability'::text\n    ELSE 'asset'::text\nEND", stored: true
    t.uuid "import_id"
    t.uuid "plaid_account_id"
    t.decimal "cash_balance", precision: 19, scale: 4, default: "0.0"
    t.jsonb "locked_attributes", default: {}
    t.string "status", default: "active"
    t.uuid "simplefin_account_id"
    t.string "effective_classification"
    t.index ["accountable_id", "accountable_type"], name: "index_accounts_on_accountable_id_and_accountable_type"
    t.index ["accountable_type"], name: "index_accounts_on_accountable_type"
    t.index ["currency"], name: "index_accounts_on_currency"
    t.index ["family_id", "accountable_type"], name: "index_accounts_on_family_id_and_accountable_type"
    t.index ["family_id", "id"], name: "index_accounts_on_family_id_and_id"
    t.index ["family_id", "status"], name: "index_accounts_on_family_id_and_status"
    t.index ["family_id"], name: "index_accounts_on_family_id"
    t.index ["import_id"], name: "index_accounts_on_import_id"
    t.index ["plaid_account_id"], name: "index_accounts_on_plaid_account_id"
    t.index ["simplefin_account_id"], name: "index_accounts_on_simplefin_account_id"
    t.index ["status"], name: "index_accounts_on_status"
  end

  create_table "active_storage_attachments", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "name", null: false
    t.string "record_type", null: false
    t.uuid "record_id", null: false
    t.uuid "blob_id", null: false
    t.datetime "created_at", null: false
    t.index ["blob_id"], name: "index_active_storage_attachments_on_blob_id"
    t.index ["record_type", "record_id", "name", "blob_id"], name: "index_active_storage_attachments_uniqueness", unique: true
  end

  create_table "active_storage_blobs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "key", null: false
    t.string "filename", null: false
    t.string "content_type"
    t.text "metadata"
    t.string "service_name", null: false
    t.bigint "byte_size", null: false
    t.string "checksum"
    t.datetime "created_at", null: false
    t.index ["key"], name: "index_active_storage_blobs_on_key", unique: true
  end

  create_table "active_storage_variant_records", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "blob_id", null: false
    t.string "variation_digest", null: false
    t.index ["blob_id", "variation_digest"], name: "index_active_storage_variant_records_uniqueness", unique: true
  end

  create_table "addresses", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "addressable_type"
    t.uuid "addressable_id"
    t.string "line1"
    t.string "line2"
    t.string "county"
    t.string "locality"
    t.string "region"
    t.string "country"
    t.integer "postal_code"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["addressable_type", "addressable_id"], name: "index_addresses_on_addressable"
  end

  create_table "api_keys", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "name"
    t.uuid "user_id", null: false
    t.json "scopes"
    t.datetime "last_used_at"
    t.datetime "expires_at"
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "display_key", null: false
    t.string "source", default: "web"
    t.index ["display_key"], name: "index_api_keys_on_display_key", unique: true
    t.index ["revoked_at"], name: "index_api_keys_on_revoked_at"
    t.index ["user_id", "source"], name: "index_api_keys_on_user_id_and_source"
    t.index ["user_id"], name: "index_api_keys_on_user_id"
  end

  create_table "balances", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.date "date", null: false
    t.decimal "balance", precision: 19, scale: 4, null: false
    t.string "currency", default: "USD", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.decimal "cash_balance", precision: 19, scale: 4, default: "0.0"
    t.decimal "start_cash_balance", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "start_non_cash_balance", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "cash_inflows", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "cash_outflows", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "non_cash_inflows", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "non_cash_outflows", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "net_market_flows", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "cash_adjustments", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "non_cash_adjustments", precision: 19, scale: 4, default: "0.0", null: false
    t.integer "flows_factor", default: 1, null: false
    t.virtual "start_balance", type: :decimal, precision: 19, scale: 4, as: "(start_cash_balance + start_non_cash_balance)", stored: true
    t.virtual "end_cash_balance", type: :decimal, precision: 19, scale: 4, as: "((start_cash_balance + ((cash_inflows - cash_outflows) * (flows_factor)::numeric)) + cash_adjustments)", stored: true
    t.virtual "end_non_cash_balance", type: :decimal, precision: 19, scale: 4, as: "(((start_non_cash_balance + ((non_cash_inflows - non_cash_outflows) * (flows_factor)::numeric)) + net_market_flows) + non_cash_adjustments)", stored: true
    t.virtual "end_balance", type: :decimal, precision: 19, scale: 4, as: "(((start_cash_balance + ((cash_inflows - cash_outflows) * (flows_factor)::numeric)) + cash_adjustments) + (((start_non_cash_balance + ((non_cash_inflows - non_cash_outflows) * (flows_factor)::numeric)) + net_market_flows) + non_cash_adjustments))", stored: true
    t.index ["account_id", "date", "currency"], name: "index_account_balances_on_account_id_date_currency_unique", unique: true
    t.index ["account_id", "date"], name: "index_balances_on_account_id_and_date", order: { date: :desc }
    t.index ["account_id"], name: "index_balances_on_account_id"
  end

  create_table "budget_categories", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "budget_id", null: false
    t.uuid "category_id", null: false
    t.decimal "budgeted_spending", precision: 19, scale: 4, null: false
    t.string "currency", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["budget_id", "category_id"], name: "index_budget_categories_on_budget_id_and_category_id", unique: true
    t.index ["budget_id"], name: "index_budget_categories_on_budget_id"
    t.index ["category_id"], name: "index_budget_categories_on_category_id"
  end

  create_table "budgets", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "family_id", null: false
    t.date "start_date", null: false
    t.date "end_date", null: false
    t.decimal "budgeted_spending", precision: 19, scale: 4
    t.decimal "expected_income", precision: 19, scale: 4
    t.string "currency", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["family_id", "start_date", "end_date"], name: "index_budgets_on_family_id_and_start_date_and_end_date", unique: true
    t.index ["family_id"], name: "index_budgets_on_family_id"
  end

  create_table "categories", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "name", null: false
    t.string "color", default: "#6172F3", null: false
    t.uuid "family_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "parent_id"
    t.string "classification", default: "expense", null: false
    t.string "lucide_icon", default: "shapes", null: false
    t.index ["family_id"], name: "index_categories_on_family_id"
  end

  create_table "chats", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "title", null: false
    t.string "instructions"
    t.jsonb "error"
    t.string "latest_assistant_response_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id"], name: "index_chats_on_user_id"
  end

  create_table "credit_cards", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.decimal "available_credit", precision: 10, scale: 2
    t.decimal "minimum_payment", precision: 10, scale: 2
    t.decimal "apr", precision: 10, scale: 2
    t.date "expiration_date"
    t.decimal "annual_fee", precision: 10, scale: 2
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
    t.string "compliance_type", default: "conventional"
    t.string "card_type"
    t.boolean "interest_free_period", default: false
    t.string "fee_structure"
    t.index ["compliance_type"], name: "index_credit_cards_on_compliance_type"
  end

  create_table "cryptos", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
  end

  create_table "data_enrichments", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "enrichable_type", null: false
    t.uuid "enrichable_id", null: false
    t.string "source"
    t.string "attribute_name"
    t.jsonb "value"
    t.jsonb "metadata"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["enrichable_id", "enrichable_type", "source", "attribute_name"], name: "idx_on_enrichable_id_enrichable_type_source_attribu_5be5f63e08", unique: true
    t.index ["enrichable_type", "enrichable_id"], name: "index_data_enrichments_on_enrichable"
  end

  create_table "depositories", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
  end

  create_table "entries", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.string "entryable_type"
    t.uuid "entryable_id"
    t.decimal "amount", precision: 19, scale: 4, null: false
    t.string "currency"
    t.date "date"
    t.string "name", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "import_id"
    t.text "notes"
    t.boolean "excluded", default: false
    t.string "plaid_id"
    t.jsonb "locked_attributes", default: {}
    t.index "lower((name)::text)", name: "index_entries_on_lower_name"
    t.index ["account_id", "date"], name: "index_entries_on_account_id_and_date"
    t.index ["account_id"], name: "index_entries_on_account_id"
    t.index ["date"], name: "index_entries_on_date"
    t.index ["entryable_type"], name: "index_entries_on_entryable_type"
    t.index ["import_id"], name: "index_entries_on_import_id"
  end

  create_table "exchange_rate_histories", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "currency_code", limit: 3, null: false
    t.decimal "rate_to_idr", precision: 18, scale: 6, null: false
    t.date "effective_date", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["currency_code", "effective_date"], name: "idx_exrate_hist_currency_date", unique: true
  end

  create_table "exchange_rates", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "from_currency", null: false
    t.string "to_currency", null: false
    t.decimal "rate", null: false
    t.date "date", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["from_currency", "to_currency", "date"], name: "index_exchange_rates_on_base_converted_date_unique", unique: true
    t.index ["from_currency"], name: "index_exchange_rates_on_from_currency"
    t.index ["to_currency"], name: "index_exchange_rates_on_to_currency"
  end

  create_table "families", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "name"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "currency", default: "USD"
    t.string "locale", default: "en"
    t.string "stripe_customer_id"
    t.string "date_format", default: "%m-%d-%Y"
    t.string "country", default: "US"
    t.string "timezone"
    t.boolean "data_enrichment_enabled", default: false
    t.boolean "early_access", default: false
    t.boolean "auto_sync_on_login", default: true, null: false
    t.datetime "latest_sync_activity_at", default: -> { "CURRENT_TIMESTAMP" }
    t.datetime "latest_sync_completed_at", default: -> { "CURRENT_TIMESTAMP" }
  end

  create_table "family_exports", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "family_id", null: false
    t.string "status", default: "pending", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["family_id"], name: "index_family_exports_on_family_id"
  end

  create_table "holdings", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.uuid "security_id", null: false
    t.date "date", null: false
    t.decimal "qty", precision: 19, scale: 4, null: false
    t.decimal "price", precision: 19, scale: 4, null: false
    t.decimal "amount", precision: 19, scale: 4, null: false
    t.string "currency", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["account_id", "security_id", "date", "currency"], name: "idx_on_account_id_security_id_date_currency_5323e39f8b", unique: true
    t.index ["account_id"], name: "index_holdings_on_account_id"
    t.index ["security_id"], name: "index_holdings_on_security_id"
  end

  create_table "impersonation_session_logs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "impersonation_session_id", null: false
    t.string "controller"
    t.string "action"
    t.text "path"
    t.string "method"
    t.string "ip_address"
    t.text "user_agent"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["impersonation_session_id"], name: "index_impersonation_session_logs_on_impersonation_session_id"
  end

  create_table "impersonation_sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "impersonator_id", null: false
    t.uuid "impersonated_id", null: false
    t.string "status", default: "pending", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["impersonated_id"], name: "index_impersonation_sessions_on_impersonated_id"
    t.index ["impersonator_id"], name: "index_impersonation_sessions_on_impersonator_id"
  end

  create_table "import_mappings", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "type", null: false
    t.string "key"
    t.string "value"
    t.boolean "create_when_empty", default: true
    t.uuid "import_id", null: false
    t.string "mappable_type"
    t.uuid "mappable_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["import_id"], name: "index_import_mappings_on_import_id"
    t.index ["mappable_type", "mappable_id"], name: "index_import_mappings_on_mappable"
  end

  create_table "import_rows", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "import_id", null: false
    t.string "account"
    t.string "date"
    t.string "qty"
    t.string "ticker"
    t.string "price"
    t.string "amount"
    t.string "currency"
    t.string "name"
    t.string "category"
    t.string "tags"
    t.string "entity_type"
    t.text "notes"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "exchange_operating_mic"
    t.index ["import_id"], name: "index_import_rows_on_import_id"
  end

  create_table "imports", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.jsonb "column_mappings"
    t.string "status"
    t.string "raw_file_str"
    t.string "normalized_csv_str"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "col_sep", default: ","
    t.uuid "family_id", null: false
    t.uuid "account_id"
    t.string "type", null: false
    t.string "date_col_label"
    t.string "amount_col_label"
    t.string "name_col_label"
    t.string "category_col_label"
    t.string "tags_col_label"
    t.string "account_col_label"
    t.string "qty_col_label"
    t.string "ticker_col_label"
    t.string "price_col_label"
    t.string "entity_type_col_label"
    t.string "notes_col_label"
    t.string "currency_col_label"
    t.string "date_format", default: "%m/%d/%Y"
    t.string "signage_convention", default: "inflows_positive"
    t.string "error"
    t.string "number_format"
    t.string "exchange_operating_mic_col_label"
    t.string "amount_type_strategy", default: "signed_amount"
    t.string "amount_type_inflow_value"
    t.index ["family_id"], name: "index_imports_on_family_id"
  end

  create_table "investments", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
  end

  create_table "invitations", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "email"
    t.string "role"
    t.string "token"
    t.uuid "family_id", null: false
    t.uuid "inviter_id", null: false
    t.datetime "accepted_at"
    t.datetime "expires_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["email", "family_id"], name: "index_invitations_on_email_and_family_id", unique: true
    t.index ["email"], name: "index_invitations_on_email"
    t.index ["family_id"], name: "index_invitations_on_family_id"
    t.index ["inviter_id"], name: "index_invitations_on_inviter_id"
    t.index ["token"], name: "index_invitations_on_token", unique: true
  end

  create_table "invite_codes", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "token", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["token"], name: "index_invite_codes_on_token", unique: true
  end

  create_table "loans", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "rate_type"
    t.decimal "interest_rate", precision: 10, scale: 3
    t.integer "term_months"
    t.decimal "initial_balance", precision: 19, scale: 4
    t.jsonb "locked_attributes", default: {}
    t.string "debt_kind"
    t.string "counterparty_type"
    t.string "counterparty_name"
    t.uuid "disbursement_account_id"
    t.date "origination_date"
    t.integer "due_day"
    t.integer "grace_days", default: 5, null: false
    t.integer "schedule_version", default: 1, null: false
    t.datetime "rescheduled_at"
    t.text "reschedule_reason"
    t.string "subtype"
    t.string "compliance_type", default: "conventional"
    t.string "islamic_product_type"
    t.decimal "profit_sharing_ratio", precision: 5, scale: 4
    t.decimal "margin_rate", precision: 10, scale: 3
    t.string "late_penalty_type", default: "conventional_fee"
    t.string "fintech_type"
    t.text "agreement_notes"
    t.string "witness_name"
    t.index ["compliance_type"], name: "index_loans_on_compliance_type"
    t.index ["counterparty_type"], name: "index_loans_on_counterparty_type"
    t.index ["debt_kind"], name: "index_loans_on_debt_kind"
    t.index ["disbursement_account_id"], name: "index_loans_on_disbursement_account_id"
    t.index ["fintech_type"], name: "index_loans_on_fintech_type"
    t.index ["islamic_product_type"], name: "index_loans_on_islamic_product_type"
  end

  create_table "merchants", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "name", null: false
    t.string "color"
    t.uuid "family_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "logo_url"
    t.string "website_url"
    t.string "type", null: false
    t.string "source"
    t.string "provider_merchant_id"
  end

  create_table "messages", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "chat_id", null: false
    t.string "type", null: false
    t.string "status", default: "complete", null: false
    t.text "content"
    t.string "ai_model"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.boolean "debug", default: false
    t.string "provider_id"
    t.boolean "reasoning", default: false
    t.index ["chat_id"], name: "index_messages_on_chat_id"
  end

  create_table "mobile_devices", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "device_id"
    t.string "device_name"
    t.string "device_type"
    t.string "os_version"
    t.string "app_version"
    t.datetime "last_seen_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "oauth_application_id"
    t.index ["oauth_application_id"], name: "index_mobile_devices_on_oauth_application_id"
    t.index ["user_id", "device_id"], name: "index_mobile_devices_on_user_id_and_device_id", unique: true
    t.index ["user_id"], name: "index_mobile_devices_on_user_id"
  end

  create_table "oauth_access_grants", force: :cascade do |t|
    t.string "resource_owner_id", null: false
    t.bigint "application_id", null: false
    t.string "token", null: false
    t.integer "expires_in", null: false
    t.text "redirect_uri", null: false
    t.string "scopes", default: "", null: false
    t.datetime "created_at", null: false
    t.datetime "revoked_at"
    t.index ["application_id"], name: "index_oauth_access_grants_on_application_id"
    t.index ["resource_owner_id"], name: "index_oauth_access_grants_on_resource_owner_id"
    t.index ["token"], name: "index_oauth_access_grants_on_token", unique: true
  end

  create_table "oauth_access_tokens", force: :cascade do |t|
    t.string "resource_owner_id"
    t.bigint "application_id", null: false
    t.string "token", null: false
    t.string "refresh_token"
    t.integer "expires_in"
    t.string "scopes"
    t.datetime "created_at", null: false
    t.datetime "revoked_at"
    t.string "previous_refresh_token", default: "", null: false
    t.index ["application_id"], name: "index_oauth_access_tokens_on_application_id"
    t.index ["refresh_token"], name: "index_oauth_access_tokens_on_refresh_token", unique: true
    t.index ["resource_owner_id"], name: "index_oauth_access_tokens_on_resource_owner_id"
    t.index ["token"], name: "index_oauth_access_tokens_on_token", unique: true
  end

  create_table "oauth_applications", force: :cascade do |t|
    t.string "name", null: false
    t.string "uid", null: false
    t.string "secret", null: false
    t.text "redirect_uri", null: false
    t.string "scopes", default: "", null: false
    t.boolean "confidential", default: true, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "owner_id"
    t.string "owner_type"
    t.index ["owner_id", "owner_type"], name: "index_oauth_applications_on_owner_id_and_owner_type"
    t.index ["uid"], name: "index_oauth_applications_on_uid", unique: true
  end

  create_table "other_assets", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
  end

  create_table "other_liabilities", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
  end

  create_table "pay_later_installments", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.integer "installment_no", null: false
    t.date "due_date", null: false
    t.string "status", default: "pending", null: false
    t.decimal "principal_amount", precision: 19, scale: 4, null: false
    t.decimal "interest_amount", precision: 19, scale: 4, null: false
    t.decimal "fee_amount", precision: 19, scale: 4, default: "0.0", null: false
    t.decimal "total_due", precision: 19, scale: 4, null: false
    t.date "paid_on"
    t.decimal "paid_amount", precision: 19, scale: 4
    t.uuid "transfer_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.decimal "applied_rate", precision: 9, scale: 6
    t.decimal "total_cost", precision: 19, scale: 4
    t.uuid "purchase_entry_id"
    t.index ["account_id", "installment_no"], name: "idx_paylater_installments_acct_no", unique: true
    t.index ["account_id"], name: "index_pay_later_installments_on_account_id"
    t.index ["purchase_entry_id"], name: "index_pay_later_installments_on_purchase_entry_id"
  end

  create_table "pay_later_rates", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "provider_name", null: false
    t.integer "tenor_months", null: false
    t.decimal "monthly_rate", precision: 9, scale: 6, null: false
    t.date "effective_date", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["provider_name", "tenor_months", "effective_date"], name: "idx_pay_later_rates_provider_tenor_eff", unique: true
  end

  create_table "pay_laters", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "provider_name"
    t.decimal "credit_limit", precision: 19, scale: 4
    t.decimal "available_credit", precision: 19, scale: 4
    t.integer "free_interest_months", default: 0, null: false
    t.decimal "late_fee_first7", precision: 19, scale: 4, default: "50000.0", null: false
    t.decimal "late_fee_per_day", precision: 19, scale: 4, default: "30000.0", null: false
    t.jsonb "interest_rate_table", default: {}
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "currency_code", limit: 3, default: "IDR", null: false
    t.decimal "exchange_rate_to_idr", precision: 18, scale: 6
    t.date "approved_date"
    t.date "expiry_date"
    t.integer "max_tenor", default: 12, null: false
    t.string "status", default: "ACTIVE", null: false
    t.text "notes"
    t.boolean "auto_update_rate", default: true, null: false
    t.string "contract_url"
    t.integer "grace_days", default: 0, null: false
    t.boolean "is_compound", default: false, null: false
    t.boolean "early_settlement_allowed", default: true, null: false
    t.decimal "early_settlement_fee", precision: 18, scale: 2
    t.string "updated_by"
  end

  create_table "personal_lendings", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "counterparty_name", null: false
    t.string "lending_direction", null: false
    t.string "lending_type", default: "informal"
    t.date "expected_return_date"
    t.date "actual_return_date"
    t.text "agreement_notes"
    t.string "witness_name"
    t.string "reminder_frequency"
    t.decimal "initial_amount", precision: 19, scale: 4
    t.string "relationship"
    t.boolean "has_written_agreement", default: false
    t.string "contact_info"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["expected_return_date"], name: "index_personal_lendings_on_expected_return_date"
    t.index ["lending_direction"], name: "index_personal_lendings_on_lending_direction"
    t.index ["lending_type"], name: "index_personal_lendings_on_lending_type"
  end

  create_table "plaid_accounts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "plaid_item_id", null: false
    t.string "plaid_id", null: false
    t.string "plaid_type", null: false
    t.string "plaid_subtype"
    t.decimal "current_balance", precision: 19, scale: 4
    t.decimal "available_balance", precision: 19, scale: 4
    t.string "currency", null: false
    t.string "name", null: false
    t.string "mask"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "raw_payload", default: {}
    t.jsonb "raw_transactions_payload", default: {}
    t.jsonb "raw_investments_payload", default: {}
    t.jsonb "raw_liabilities_payload", default: {}
    t.index ["plaid_id"], name: "index_plaid_accounts_on_plaid_id", unique: true
    t.index ["plaid_item_id"], name: "index_plaid_accounts_on_plaid_item_id"
  end

  create_table "plaid_items", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "family_id", null: false
    t.string "access_token"
    t.string "plaid_id", null: false
    t.string "name"
    t.string "next_cursor"
    t.boolean "scheduled_for_deletion", default: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "available_products", default: [], array: true
    t.string "billed_products", default: [], array: true
    t.string "plaid_region", default: "us", null: false
    t.string "institution_url"
    t.string "institution_id"
    t.string "institution_color"
    t.string "status", default: "good", null: false
    t.jsonb "raw_payload", default: {}
    t.jsonb "raw_institution_payload", default: {}
    t.index ["family_id"], name: "index_plaid_items_on_family_id"
    t.index ["plaid_id"], name: "index_plaid_items_on_plaid_id", unique: true
  end

  create_table "properties", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "year_built"
    t.integer "area_value"
    t.string "area_unit"
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
  end

  create_table "rejected_transfers", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "inflow_transaction_id", null: false
    t.uuid "outflow_transaction_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["inflow_transaction_id", "outflow_transaction_id"], name: "idx_on_inflow_transaction_id_outflow_transaction_id_412f8e7e26", unique: true
    t.index ["inflow_transaction_id"], name: "index_rejected_transfers_on_inflow_transaction_id"
    t.index ["outflow_transaction_id"], name: "index_rejected_transfers_on_outflow_transaction_id"
  end

  create_table "rule_actions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "rule_id", null: false
    t.string "action_type", null: false
    t.string "value"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["rule_id"], name: "index_rule_actions_on_rule_id"
  end

  create_table "rule_conditions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "rule_id"
    t.uuid "parent_id"
    t.string "condition_type", null: false
    t.string "operator", null: false
    t.string "value"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["parent_id"], name: "index_rule_conditions_on_parent_id"
    t.index ["rule_id"], name: "index_rule_conditions_on_rule_id"
  end

  create_table "rules", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "family_id", null: false
    t.string "resource_type", null: false
    t.date "effective_date"
    t.boolean "active", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "name"
    t.index ["family_id"], name: "index_rules_on_family_id"
  end

  create_table "securities", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "ticker", null: false
    t.string "name"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "country_code"
    t.string "exchange_mic"
    t.string "exchange_acronym"
    t.string "logo_url"
    t.string "exchange_operating_mic"
    t.boolean "offline", default: false, null: false
    t.datetime "failed_fetch_at"
    t.integer "failed_fetch_count", default: 0, null: false
    t.datetime "last_health_check_at"
    t.index "upper((ticker)::text), COALESCE(upper((exchange_operating_mic)::text), ''::text)", name: "index_securities_on_ticker_and_exchange_operating_mic_unique", unique: true
    t.index ["country_code"], name: "index_securities_on_country_code"
    t.index ["exchange_operating_mic"], name: "index_securities_on_exchange_operating_mic"
  end

  create_table "security_prices", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.date "date", null: false
    t.decimal "price", precision: 19, scale: 4, null: false
    t.string "currency", default: "USD", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "security_id"
    t.index ["security_id", "date", "currency"], name: "index_security_prices_on_security_id_and_date_and_currency", unique: true
    t.index ["security_id"], name: "index_security_prices_on_security_id"
  end

  create_table "sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "user_agent"
    t.string "ip_address"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "active_impersonator_session_id"
    t.datetime "subscribed_at"
    t.jsonb "prev_transaction_page_params", default: {}
    t.jsonb "data", default: {}
    t.index ["active_impersonator_session_id"], name: "index_sessions_on_active_impersonator_session_id"
    t.index ["user_id"], name: "index_sessions_on_user_id"
  end

  create_table "settings", force: :cascade do |t|
    t.string "var", null: false
    t.text "value"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["var"], name: "index_settings_on_var", unique: true
  end

  create_table "simplefin_accounts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "simplefin_item_id", null: false
    t.string "name"
    t.string "account_id"
    t.string "currency"
    t.decimal "current_balance", precision: 19, scale: 4
    t.decimal "available_balance", precision: 19, scale: 4
    t.string "account_type"
    t.string "account_subtype"
    t.jsonb "raw_payload"
    t.jsonb "raw_transactions_payload"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "balance_date"
    t.jsonb "extra"
    t.jsonb "org_data"
    t.index ["account_id"], name: "index_simplefin_accounts_on_account_id"
    t.index ["simplefin_item_id"], name: "index_simplefin_accounts_on_simplefin_item_id"
  end

  create_table "simplefin_items", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "family_id", null: false
    t.text "access_url"
    t.string "name"
    t.string "institution_id"
    t.string "institution_name"
    t.string "institution_url"
    t.string "status", default: "good"
    t.boolean "scheduled_for_deletion", default: false
    t.jsonb "raw_payload"
    t.jsonb "raw_institution_payload"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.boolean "pending_account_setup", default: false, null: false
    t.index ["family_id"], name: "index_simplefin_items_on_family_id"
    t.index ["status"], name: "index_simplefin_items_on_status"
  end

  create_table "subscriptions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "family_id", null: false
    t.string "status", null: false
    t.string "stripe_id"
    t.decimal "amount", precision: 19, scale: 4
    t.string "currency"
    t.string "interval"
    t.datetime "current_period_ends_at"
    t.datetime "trial_ends_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["family_id"], name: "index_subscriptions_on_family_id", unique: true
  end

  create_table "syncs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "syncable_type", null: false
    t.uuid "syncable_id", null: false
    t.string "status", default: "pending"
    t.string "error"
    t.jsonb "data"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "parent_id"
    t.datetime "pending_at"
    t.datetime "syncing_at"
    t.datetime "completed_at"
    t.datetime "failed_at"
    t.date "window_start_date"
    t.date "window_end_date"
    t.index ["parent_id"], name: "index_syncs_on_parent_id"
    t.index ["status"], name: "index_syncs_on_status"
    t.index ["syncable_type", "syncable_id"], name: "index_syncs_on_syncable"
  end

  create_table "taggings", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "tag_id", null: false
    t.string "taggable_type"
    t.uuid "taggable_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["tag_id"], name: "index_taggings_on_tag_id"
    t.index ["taggable_type", "taggable_id"], name: "index_taggings_on_taggable"
  end

  create_table "tags", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "name"
    t.string "color", default: "#e99537", null: false
    t.uuid "family_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["family_id"], name: "index_tags_on_family_id"
  end

  create_table "tool_calls", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "message_id", null: false
    t.string "provider_id", null: false
    t.string "provider_call_id"
    t.string "type", null: false
    t.string "function_name"
    t.jsonb "function_arguments"
    t.jsonb "function_result"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["message_id"], name: "index_tool_calls_on_message_id"
  end

  create_table "trades", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "security_id", null: false
    t.decimal "qty", precision: 19, scale: 4
    t.decimal "price", precision: 19, scale: 4
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "currency"
    t.jsonb "locked_attributes", default: {}
    t.index ["security_id"], name: "index_trades_on_security_id"
  end

  create_table "transactions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "category_id"
    t.uuid "merchant_id"
    t.jsonb "locked_attributes", default: {}
    t.string "kind", default: "standard", null: false
    t.string "external_id"
    t.boolean "is_sharia_compliant", default: true
    t.string "islamic_transaction_type"
    t.index ["category_id"], name: "index_transactions_on_category_id"
    t.index ["external_id"], name: "index_transactions_on_external_id"
    t.index ["is_sharia_compliant"], name: "index_transactions_on_is_sharia_compliant"
    t.index ["islamic_transaction_type"], name: "index_transactions_on_islamic_transaction_type"
    t.index ["kind"], name: "index_transactions_on_kind"
    t.index ["merchant_id"], name: "index_transactions_on_merchant_id"
  end

  create_table "transfers", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "inflow_transaction_id", null: false
    t.uuid "outflow_transaction_id", null: false
    t.string "status", default: "pending", null: false
    t.text "notes"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["inflow_transaction_id", "outflow_transaction_id"], name: "idx_on_inflow_transaction_id_outflow_transaction_id_8cd07a28bd", unique: true
    t.index ["inflow_transaction_id"], name: "index_transfers_on_inflow_transaction_id"
    t.index ["outflow_transaction_id"], name: "index_transfers_on_outflow_transaction_id"
    t.index ["status"], name: "index_transfers_on_status"
  end

  create_table "users", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "family_id"
    t.string "first_name"
    t.string "last_name"
    t.string "email"
    t.string "password_digest"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "role", default: "member", null: false
    t.boolean "active", default: true, null: false
    t.datetime "onboarded_at"
    t.string "unconfirmed_email"
    t.string "otp_secret"
    t.boolean "otp_required", default: false, null: false
    t.string "otp_backup_codes", default: [], array: true
    t.boolean "show_sidebar", default: true
    t.string "default_period", default: "last_30_days", null: false
    t.uuid "last_viewed_chat_id"
    t.boolean "show_ai_sidebar", default: true
    t.boolean "ai_enabled", default: false, null: false
    t.string "theme", default: "system"
    t.boolean "rule_prompts_disabled", default: false
    t.datetime "rule_prompt_dismissed_at"
    t.text "goals", default: [], array: true
    t.datetime "set_onboarding_preferences_at"
    t.datetime "set_onboarding_goals_at"
    t.string "default_account_order", default: "name_asc"
    t.index ["email"], name: "index_users_on_email", unique: true
    t.index ["family_id"], name: "index_users_on_family_id"
    t.index ["last_viewed_chat_id"], name: "index_users_on_last_viewed_chat_id"
    t.index ["otp_secret"], name: "index_users_on_otp_secret", unique: true, where: "(otp_secret IS NOT NULL)"
  end

  create_table "valuations", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.jsonb "locked_attributes", default: {}
    t.string "kind", default: "reconciliation", null: false
  end

  create_table "vehicles", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "year"
    t.integer "mileage_value"
    t.string "mileage_unit"
    t.string "make"
    t.string "model"
    t.jsonb "locked_attributes", default: {}
    t.string "subtype"
  end

  add_foreign_key "mobile_devices", "users"
  add_foreign_key "oauth_access_grants", "oauth_applications", column: "application_id"
  add_foreign_key "oauth_access_tokens", "oauth_applications", column: "application_id"
  add_foreign_key "pay_later_installments", "transfers", on_delete: :nullify
  add_foreign_key "plaid_accounts", "plaid_items"
  add_foreign_key "rejected_transfers", "transactions", column: "inflow_transaction_id"
  add_foreign_key "rejected_transfers", "transactions", column: "outflow_transaction_id"
  add_foreign_key "rule_actions", "rules"
  add_foreign_key "rule_conditions", "rule_conditions", column: "parent_id"
  add_foreign_key "rule_conditions", "rules"
  add_foreign_key "security_prices", "securities"
  add_foreign_key "sessions", "users"
  add_foreign_key "simplefin_accounts", "simplefin_items"
  add_foreign_key "syncs", "syncs", column: "parent_id"
  add_foreign_key "taggings", "tags"
  add_foreign_key "tool_calls", "messages"
  add_foreign_key "trades", "securities"
  add_foreign_key "transfers", "transactions", column: "inflow_transaction_id", on_delete: :cascade
  add_foreign_key "transfers", "transactions", column: "outflow_transaction_id", on_delete: :cascade
end
