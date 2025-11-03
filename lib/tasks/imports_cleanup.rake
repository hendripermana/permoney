module ImportsCleanupHelper
  extend self

  def cleanup_imports(scope:, failed_condition:, old_condition:)
    puts "Cleaning up import records..."

    failed_imports = scope.where(failed_condition)
    puts "Found #{failed_imports.count} failed import records"

    old_imports = old_condition ? scope.instance_exec(&old_condition) : Import.none
    puts "Found #{old_imports.count} old incomplete import records" if old_condition

    imports_to_delete = (failed_imports.to_a + old_imports.to_a).uniq

    return puts "No imports to clean up." if imports_to_delete.empty?

    display_imports_to_delete(imports_to_delete)

    return puts "Cleanup cancelled." unless confirm_deletion?

    deleted_count = delete_imports(imports_to_delete)
    puts "\nSuccessfully deleted #{deleted_count} import(s)."
  end

  private

    def display_imports_to_delete(imports)
      puts "\nImports to be deleted:"
      imports.each do |import|
        error_preview = import.error&.truncate(50)
        puts "  - ID: #{import.id}, Status: #{import.status}, Created: #{import.created_at}, Error: #{error_preview}"
      end
    end

    def confirm_deletion?
      print "\nDelete these imports? (yes/no): "
      STDIN.gets.chomp.casecmp?("yes")
    end

    def delete_imports(imports)
      imports.sum do |import|
        import.destroy!
        1
      rescue StandardError => e
        puts "Error deleting import #{import.id}: #{e.message}"
        0
      end
    end
end

namespace :imports do
  desc "Clean up old or failed AccountImport records"
  task cleanup_account_imports: :environment do
    ImportsCleanupHelper.cleanup_imports(
      scope: Import.where(type: "AccountImport"),
      failed_condition: { status: :failed },
      old_condition: -> { where.not(status: :complete).where("created_at < ?", 30.days.ago) }
    )
  end

  desc "Clean up all failed imports (any type)"
  task cleanup_failed: :environment do
    ImportsCleanupHelper.cleanup_imports(
      scope: Import.all,
      failed_condition: { status: :failed },
      old_condition: nil
    )
  end
end
