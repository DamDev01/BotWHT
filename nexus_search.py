import requests
import json
from bs4 import BeautifulSoup
import os
import time

class NexusSearch:
    def __init__(self):
        self.base_urls = [
            "https://annas-archive.org",
            "https://libgen.is",
            "https://libgen.rs",
            "https://libgen.li"
        ]
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }

    def search_scientific(self, query, limit=5):
        results = []
        for base_url in self.base_urls:
            try:
                url = f"{base_url}/search.php?req={query}&open=0&res=25&view=simple&phrase=1&column=def"
                response = requests.get(url, headers=self.headers, timeout=10)
                if response.status_code == 200:
                    soup = BeautifulSoup(response.text, 'html.parser')
                    links = soup.find_all('a', href=True)
                    
                    for link in links:
                        if '/get.php?' in link['href'] or '/book/' in link['href']:
                            title_elem = link.find_parent('td')
                            if title_elem and len(results) < limit:
                                results.append({
                                    'title': link.text.strip(),
                                    'url': f"{base_url}{link['href']}" if link['href'].startswith('/') else link['href'],
                                    'source': base_url
                                })
                            
            except Exception as e:
                print(f"Erro ao buscar em {base_url}: {str(e)}")
                continue
                
        return results

    def search_books(self, query, limit=5):
        results = []
        for base_url in self.base_urls:
            try:
                if 'annas-archive.org' in base_url:
                    url = f"{base_url}/search?q={query}"
                else:
                    url = f"{base_url}/fiction/?q={query}"
                
                response = requests.get(url, headers=self.headers, timeout=10)
                if response.status_code == 200:
                    soup = BeautifulSoup(response.text, 'html.parser')
                    
                    # Procura por links de livros
                    books = soup.find_all(['div', 'tr'], class_=['book-result', 'bookRow'])
                    for book in books:
                        if len(results) >= limit:
                            break
                            
                        title_elem = book.find(['h3', 'a'], class_=['title', 'bookTitle'])
                        if title_elem:
                            link = title_elem.get('href', '')
                            if not link and title_elem.find('a'):
                                link = title_elem.find('a').get('href', '')
                            
                            if link:
                                results.append({
                                    'title': title_elem.text.strip(),
                                    'url': f"{base_url}{link}" if link.startswith('/') else link,
                                    'source': base_url
                                })
                            
            except Exception as e:
                print(f"Erro ao buscar em {base_url}: {str(e)}")
                continue
                
        return results

    def download_file(self, url):
        try:
            response = requests.get(url, headers=self.headers, stream=True, timeout=30)
            if response.status_code == 200:
                # Pega o nome do arquivo da URL ou do cabeçalho
                filename = os.path.basename(url.split('?')[0])
                if 'content-disposition' in response.headers:
                    filename = response.headers['content-disposition'].split('filename=')[1].strip('"')
                
                if not filename.endswith('.pdf'):
                    filename += '.pdf'
                    
                filepath = f"downloads/{filename}"
                os.makedirs('downloads', exist_ok=True)
                
                with open(filepath, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            
                return filepath
                
        except Exception as e:
            print(f"Erro ao baixar arquivo: {str(e)}")
            return None
            
        return None

def main():
    import sys
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Argumentos insuficientes"}))
        sys.exit(1)
    query = sys.argv[1]
    search_type = sys.argv[2]
    nexus = NexusSearch()
    try:
        if search_type == "scientific":
            results = nexus.search_scientific(query)
        else:
            results = nexus.search_books(query)
        print(json.dumps(results))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()