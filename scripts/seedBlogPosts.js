?const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');
require('dotenv').config();

const samplePosts = [
  {
    title: 'Jak wybrać najlepszego hydraulika? 10 rzeczy, które musisz sprawdzić',
    slug: 'jak-wybrac-najlepszego-hydraulika',
    excerpt: 'Szukasz hydraulika, ale nie wiesz, na co zwrócić uwagę? Oto 10 najważniejszych rzeczy, które pomogą Ci wybrać najlepszego specjalistę.',
    content: `# Jak wybrać najlepszego hydraulika? 10 rzeczy, które musisz sprawdzić

Szukasz hydraulika, ale nie wiesz, na co zwrócić uwagę? Oto 10 najważniejszych rzeczy, które pomogą Ci wybrać najlepszego specjalistę.

## 1. Sprawdź opinie i oceny

Opinie innych klientów to najlepsze źródło informacji o jakości usług. Zwróć uwagę na:
- Średnią ocenę (szukaj wykonawców z 4.5+ gwiazdkami)
- Liczbę opinii (im więcej, tym lepiej)
- Szczegóły w recenzjach - co klienci chwalą, a co krytykują

## 2. Zweryfikowany profil

Zweryfikowani wykonawcy przeszli proces weryfikacji tożsamości i kwalifikacji. To gwarancja, że masz do czynienia z prawdziwym specjalistą.

## 3. Doświadczenie i portfolio

Sprawdź:
- Jak długo wykonawca działa na rynku
- Czy ma portfolio zrealizowanych prac
- Czy specjalizuje się w konkretnych usługach

## 4. Dostępność i czas reakcji

Dobra firma hydrauliczna:
- Odpowiada na zapytania w ciągu 2-4 godzin
- Ma jasno określone godziny pracy
- Oferuje usługi awaryjne (24/7)

## 5. Transparentne ceny

Unikaj wykonawców, którzy:
- Nie podają cen z góry
- Mają "ukryte" koszty
- Nie chcą podać szacunkowej wyceny

## 6. Gwarancja na wykonane prace

Profesjonalny hydraulik zawsze daje gwarancję na swoje usługi. Standardowo jest to 12-24 miesiące.

## 7. Ubezpieczenie OC

Sprawdź, czy wykonawca ma ubezpieczenie OC. To ochrona na wypadek szkód podczas naprawy.

## 8. Szybka wycena

Dobra firma:
- Odpowiada na zapytania szybko
- Podaje wycenę w ciągu 24 godzin
- Jest konkretna w ofercie

## 9. Profesjonalne podejście

Zwróć uwagę na:
- Sposób komunikacji
- Punktualność
- Czystość i porządek podczas pracy

## 10. Rekomendacje znajomych

Jeśli znajomi polecają konkretnego hydraulika, to dobry znak. Sprawdź go również na Helpfli!

---

**Podsumowanie:** Wybór dobrego hydraulika to inwestycja w spokój i bezpieczeństwo. Nie oszczędzaj na jakości - lepiej zapłacić trochę więcej za profesjonalną usługę niż później naprawiać błędy amatora.

Szukasz hydraulika? Sprawdź zweryfikowanych wykonawców na Helpfli!`,
    category: 'porady',
    tags: ['hydraulik', 'porady', 'wybór wykonawcy', 'remont'],
    metaTitle: 'Jak wybrać najlepszego hydraulika? 10 rzeczy do sprawdzenia | Helpfli',
    metaDescription: 'Szukasz hydraulika? Sprawdź 10 najważniejszych rzeczy, które pomogą Ci wybrać najlepszego specjalistę. Opinie, weryfikacja, ceny i gwarancje.',
    keywords: ['hydraulik', 'wybór hydraulika', 'jak wybrać hydraulika', 'dobry hydraulik', 'hydraulik Warszawa']
  },
  {
    title: '10 rzeczy do sprawdzenia przed remontem mieszkania',
    slug: '10-rzeczy-przed-remontem-mieszkania',
    excerpt: 'Planujesz remont? Sprawdź te 10 rzeczy przed rozpoczęciem prac, aby uniknąć problemów i nieprzyjemnych niespodzianek.',
    content: `# 10 rzeczy do sprawdzenia przed remontem mieszkania

Planujesz remont? Sprawdź te 10 rzeczy przed rozpoczęciem prac, aby uniknąć problemów i nieprzyjemnych niespodzianek.

## 1. Budżet i harmonogram

Przed rozpoczęciem remontu:
- Określ dokładny budżet (dodaj 20% zapasu na nieprzewidziane koszty)
- Zaplanuj harmonogram prac
- Uwzględnij czas na zakupy materiałów

## 2. Pozwolenia i zgody

Sprawdź, czy potrzebujesz:
- Pozwolenia na budowę (dla większych remontów)
- Zgody wspólnoty mieszkaniowej
- Zgody sąsiadów (jeśli remont będzie uciążliwy)

## 3. Stan techniczny mieszkania

Przed remontem sprawdź:
- Stan instalacji elektrycznej
- Stan instalacji wodno-kanalizacyjnej
- Stan ścian i sufitów (wilgoć, pęknięcia)

## 4. Wybór wykonawców

Znajdź sprawdzonych wykonawców:
- Sprawdź opinie i oceny
- Porównaj oferty (minimum 3)
- Sprawdź referencje

## 5. Materiały i wyposażenie

Zdecyduj wcześniej:
- Jakie materiały chcesz użyć
- Gdzie je kupisz
- Kto będzie je dostarczał

## 6. Miejsce do mieszkania podczas remontu

Jeśli remont jest duży:
- Zastanów się, gdzie będziesz mieszkać
- Zabezpiecz meble i sprzęty
- Zaplanuj miejsce na materiały

## 7. Ubezpieczenie

Sprawdź:
- Czy masz ubezpieczenie mieszkania
- Czy wykonawcy mają ubezpieczenie OC
- Czy materiały są ubezpieczone

## 8. Umowa z wykonawcą

Zawsze podpisuj umowę zawierającą:
- Szczegółowy zakres prac
- Harmonogram
- Warunki płatności
- Gwarancję

## 9. Przygotowanie mieszkania

Przed rozpoczęciem:
- Opróżnij pomieszczenia
- Zabezpiecz podłogi i meble
- Zapewnij dostęp do mediów

## 10. Plan awaryjny

Miej plan na wypadek:
- Przekroczenia budżetu
- Opóźnień w harmonogramie
- Problemów z wykonawcą

---

**Podsumowanie:** Dobrze zaplanowany remont to połowa sukcesu. Nie spiesz się - lepiej poświęcić więcej czasu na przygotowania niż później naprawiać błędy.

Szukasz wykonawców do remontu? Sprawdź zweryfikowanych specjalistów na Helpfli!`,
    category: 'porady',
    tags: ['remont', 'porady', 'mieszkanie', 'planowanie'],
    metaTitle: '10 rzeczy do sprawdzenia przed remontem mieszkania | Helpfli',
    metaDescription: 'Planujesz remont? Sprawdź 10 najważniejszych rzeczy przed rozpoczęciem prac. Budżet, pozwolenia, wykonawcy i więcej.',
    keywords: ['remont mieszkania', 'przed remontem', 'planowanie remontu', 'remont porady']
  },
  {
    title: 'Jak oszczędzić na naprawach? 7 sprawdzonych sposobów',
    slug: 'jak-oszczedzic-na-naprawach',
    excerpt: 'Naprawy mogą być kosztowne, ale są sposoby, aby zaoszczędzić. Oto 7 sprawdzonych metod, które pomogą Ci zmniejszyć koszty napraw.',
    content: `# Jak oszczędzić na naprawach? 7 sprawdzonych sposobów

Naprawy mogą być kosztowne, ale są sposoby, aby zaoszczędzić. Oto 7 sprawdzonych metod, które pomogą Ci zmniejszyć koszty napraw.

## 1. Porównaj oferty

Zawsze porównuj oferty od minimum 3 wykonawców:
- Różnice w cenach mogą być znaczne
- Sprawdź, co dokładnie obejmuje cena
- Nie wybieraj najtańszej oferty bez sprawdzenia

## 2. Wykorzystaj program lojalnościowy

Na Helpfli możesz:
- Zbierać punkty lojalnościowe
- Wymieniać punkty na zniżki
- Otrzymywać specjalne oferty dla stałych klientów

## 3. Wybierz odpowiedni czas

Niektóre usługi są tańsze:
- Poza sezonem (np. ogrzewanie latem)
- W dni powszednie (nie w weekendy)
- W godzinach porannych

## 4. Zrób to sam (jeśli możesz)

Dla prostych napraw:
- Sprawdź tutoriale online
- Kup materiały samodzielnie
- Wykonaj prostą naprawę sam

## 5. Użyj używanych części (gdy to możliwe)

Dla niektórych napraw:
- Używane części mogą być znacznie tańsze
- Sprawdź gwarancję i stan
- Zapytaj wykonawcę o opinię

## 6. Negocjuj cenę

Nie bój się negocjować:
- Przy większych naprawach możesz wynegocjować zniżkę
- Zapytaj o możliwość płatności ratalnej
- Sprawdź, czy są dostępne promocje

## 7. Zapobiegaj awariom

Najlepszy sposób na oszczędności:
- Regularne przeglądy
- Konserwacja urządzeń
- Szybka reakcja na pierwsze objawy problemu

---

**Podsumowanie:** Oszczędzanie na naprawach to nie tylko wybór najtańszej oferty. To mądre planowanie, porównywanie i zapobieganie problemom.

Szukasz wykonawcy? Porównaj oferty na Helpfli i zaoszczędź!`,
    category: 'porady',
    tags: ['oszczędzanie', 'naprawy', 'porady', 'finanse'],
    metaTitle: 'Jak oszczędzić na naprawach? 7 sprawdzonych sposobów | Helpfli',
    metaDescription: 'Naprawy mogą być kosztowne. Sprawdź 7 sprawdzonych sposobów, jak zaoszczędzić na naprawach. Porównywanie ofert, program lojalnościowy i więcej.',
    keywords: ['oszczędzanie na naprawach', 'tanie naprawy', 'jak oszczędzić', 'naprawy porady']
  }
];

async function seedBlogPosts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Connected to MongoDB');
    
    // Usuń istniejące posty (opcjonalnie)
    // await BlogPost.deleteMany({});
    
    // Dodaj przykładowe posty
    for (const postData of samplePosts) {
      const existing = await BlogPost.findOne({ slug: postData.slug });
      if (!existing) {
        const post = await BlogPost.create({
          ...postData,
          published: true,
          publishedAt: new Date(),
          readingTime: Math.ceil(postData.content.split(/\s+/).length / 200)
        });
        console.log(`✅ Created blog post: ${post.title}`);
      } else {
        console.log(`⏭️  Post already exists: ${postData.slug}`);
      }
    }
    
    console.log('✅ Blog posts seeded successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding blog posts:', error);
    process.exit(1);
  }
}

seedBlogPosts();










