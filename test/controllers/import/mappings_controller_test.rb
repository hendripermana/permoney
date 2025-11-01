require "test_helper"

class Import::MappingsControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in @user = users(:family_admin)

    @import = imports(:transaction)
  end

  test "updates mapping" do
    mapping = import_mappings(:one)
    new_category = categories(:income)

    patch import_mapping_path(@import, mapping), params: {
      import_mapping: {
        type: "Import::CategoryMapping",
        mappable_type: "Category",
        mappable_id: new_category.id,
        key: "Food"
      }
    }

    mapping.reload

    assert_equal new_category, mapping.mappable
    assert_equal "Food", mapping.key

    assert_redirected_to import_confirm_path(@import)
  end

  test "updates account type mapping" do
    import = imports(:account)
    import.rows.create!(entity_type: "Checking", name: "Test", amount: "1000", currency: "USD")
    import.sync_mappings
    
    mapping = import.mappings.account_types.first
    assert_not_nil mapping, "Account type mapping should exist after sync_mappings"
    
    patch import_mapping_path(import, mapping), params: {
      import_mapping: {
        type: "Import::AccountTypeMapping",
        key: mapping.key,
        value: "Depository"
      }
    }

    mapping.reload

    assert_equal "Depository", mapping.value
    assert_redirected_to import_confirm_path(import)
  end
end
