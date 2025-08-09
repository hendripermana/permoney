module Brankas
	class SyncJob < ApplicationJob
		queue_as :default

		def perform
			# No-op placeholder; implement Brankas sync later.
		end
	end
end

