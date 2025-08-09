module Brankas
	class Client
		def initialize(api_key: ENV["BRANKAS_API_KEY"], base_url: ENV["BRANKAS_BASE_URL"]) = (@api_key, @base_url = api_key, base_url)
	end
end

