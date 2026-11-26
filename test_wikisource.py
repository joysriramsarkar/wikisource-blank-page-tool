# -*- coding: utf-8 -*-
import unittest

import wikisource as ws

INDEX_TEXT = """{{:MediaWiki:Proofreadpage_index_template
|Source=pdf
|Pages=<pagelist 1="মলাট" 2to4="—" 5="প্রচ্ছদ" 6="প্রকাশক" 7="নিবেদন" 8="—" 9="1" 9to11="prpbengalicurrency" 12="—" 13="1" 303="চিত্র" 304="—" 305="291" 308="—" 309="বিজ্ঞাপন" />
}}"""

BLANK_CONTENT = ('<noinclude><pagequality level="0" user="জয়শ্রীরাম সরকার" />'
                 '</noinclude><noinclude></noinclude>')


class PagelistTests(unittest.TestCase):
    def test_parse_sample(self):
        result = ws.parse_pagelist(INDEX_TEXT)
        self.assertEqual(result.tag_count, 1)
        self.assertEqual(result.blank_pages, {2, 3, 4, 8, 12, 304, 308})
        self.assertEqual(result.max_page, 309)
        self.assertEqual(result.labels[1], "মলাট")
        self.assertEqual(result.labels[5], "প্রচ্ছদ")
        self.assertEqual(result.labels[303], "চিত্র")
        self.assertEqual(result.labels[309], "বিজ্ঞাপন")
        self.assertEqual(result.labels[9], "1")
        self.assertNotIn(10, result.labels)  # numbering scheme, not a label

    def test_bengali_digits_and_spaces(self):
        text = '<pagelist ১to৩="—" 5 = "-" />'
        result = ws.parse_pagelist(text)
        self.assertEqual(result.blank_pages, {1, 2, 3, 5})
        self.assertEqual(result.max_page, 5)

    def test_multiple_tags(self):
        text = '<pagelist 1="—" /><pagelist 3to5="–" />'
        result = ws.parse_pagelist(text)
        self.assertEqual(result.tag_count, 2)
        self.assertEqual(result.blank_pages, {1, 3, 4, 5})

    def test_blank_markers(self):
        for value in ("—", "-", " – ", "--", "−"):
            self.assertTrue(ws.is_blank_marker(value), value)
        for value in ("", "1", "চিত্র", "prpbengalicurrency"):
            self.assertFalse(ws.is_blank_marker(value), value)


class NumberTests(unittest.TestCase):
    def test_page_number(self):
        self.assertEqual(ws.page_number("পাতা:বই.pdf/১২"), 12)
        self.assertEqual(ws.page_number("পাতা:বই.pdf/12"), 12)
        self.assertIsNone(ws.page_number("পাতা:বই.pdf/টীকা"))
        self.assertIsNone(ws.page_number("পাতা:বই.pdf"))

    def test_digit_style(self):
        self.assertEqual(ws.digit_style("পাতা:বই.pdf/১২"), "bn")
        self.assertEqual(ws.digit_style("পাতা:বই.pdf/12"), "ascii")

    def test_format_page_number(self):
        self.assertEqual(ws.format_page_number(12, "bn"), "১২")
        self.assertEqual(ws.format_page_number(12, "ascii"), "12")


class BlankContentTests(unittest.TestCase):
    def test_level_zero_page_is_blank(self):
        self.assertTrue(ws.is_blank_content(BLANK_CONTENT))

    def test_page_with_text_is_not_blank(self):
        content = ('<noinclude><pagequality level="1" user="X" /></noinclude>'
                   'আলো একটি অত্যন্ত প্রয়োজনীয় বস্তু।<noinclude></noinclude>')
        self.assertFalse(ws.is_blank_content(content))

    def test_noop_markup_is_blank(self):
        self.assertTrue(ws.is_blank_content("{{nop}}"))
        self.assertTrue(ws.is_blank_content("<noinclude>{{rh|||১২}}</noinclude>"))
        self.assertTrue(ws.is_blank_content("<!-- শুধু মন্তব্য -->"))
        self.assertTrue(ws.is_blank_content("—"))

    def test_header_alone_is_blank(self):
        content = '<noinclude><pagequality level="0" user="X" /></noinclude><noinclude>{{rh|২|আলো|}}</noinclude>'
        self.assertTrue(ws.is_blank_content(content))

    def test_quality_parsing(self):
        self.assertEqual(ws.parse_quality(BLANK_CONTENT), (0, "জয়শ্রীরাম সরকার"))
        self.assertEqual(ws.parse_quality("কোনো ট্যাগ নেই"), (None, None))

    def test_set_quality_zero(self):
        content = ('<noinclude><pagequality level="1" user="পুরনো" /></noinclude>'
                   '<noinclude></noinclude>')
        updated = ws.set_quality_zero(content, "নতুন")
        self.assertIn('level="0"', updated)
        self.assertIn('user="নতুন"', updated)
        self.assertNotIn('level="1"', updated)
        self.assertIn("<noinclude></noinclude>", updated)

    def test_set_quality_zero_adds_missing_tag(self):
        updated = ws.set_quality_zero("", "ব্যবহারকারী")
        self.assertEqual(updated, ws.build_blank_content("ব্যবহারকারী"))

    def test_set_quality_zero_paired_tag(self):
        content = ('<noinclude><pagequality level="1" user="পুরনো"></pagequality>'
                   '</noinclude>')
        updated = ws.set_quality_zero(content, "নতুন")
        self.assertIn('<pagequality level="0" user="নতুন" />', updated)
        self.assertNotIn("</pagequality>", updated)
        self.assertNotIn('level="1"', updated)


class ManualRecordTests(unittest.TestCase):
    def setUp(self):
        self.client = ws.WikiClient.__new__(ws.WikiClient)
        self.client.origin = "https://bn.wikisource.org"
        self.client.article_path = "/wiki/$1"
        self.client.ns_page = "পাতা"
        self.client.lang = "bn"

    def make_page(self, title, content, *, redirect=False, missing=False):
        return {
            "title": title,
            "ns": 104,
            "missing": missing,
            "redirect": redirect,
            "content": content,
            "revid": 123,
            "user": "পরীক্ষক",
            "timestamp": "2026-01-01T00:00:00Z",
        }

    def record(self, group, in_pagelist=False):
        return self.client.manual_page_record(
            4, group,
            base="বই.pdf", style="bn", pagecount=10, thumb_base=None,
            labels={}, in_pagelist=in_pagelist,
        )

    def test_missing_page_is_create(self):
        record = self.record([])
        self.assertEqual(record["kind"], "create")
        self.assertEqual(record["title"], "পাতা:বই.pdf/৪")
        self.assertTrue(record["manual"])

    def test_empty_page_with_level_is_update(self):
        page = self.make_page(
            "পাতা:বই.pdf/৪",
            '<noinclude><pagequality level="1" user="X" /></noinclude>',
        )
        record = self.record([page])
        self.assertEqual(record["kind"], "update")
        self.assertEqual(record["level"], 1)

    def test_empty_level_zero_is_done(self):
        page = self.make_page(
            "পাতা:বই.pdf/৪",
            '<noinclude><pagequality level="0" user="X" /></noinclude>',
        )
        self.assertEqual(self.record([page])["kind"], "done")

    def test_text_page_is_conflict(self):
        page = self.make_page(
            "পাতা:বই.pdf/৪",
            '<noinclude><pagequality level="1" user="X" /></noinclude>আলো',
        )
        record = self.record([page])
        self.assertEqual(record["kind"], "conflict")
        self.assertTrue(record["has_text"])
        self.assertIn("আলো", record["excerpt"])

    def test_redirect_only_is_redirect(self):
        page = self.make_page(
            "পাতা:বই.pdf/৪",
            "#পুনর্নির্দেশ [[পাতা:বই.pdf/৫]]",
            redirect=True,
        )
        self.assertEqual(self.record([page])["kind"], "redirect")

    def test_search_results_merge_and_strip(self):
        client = ws.WikiClient.__new__(ws.WikiClient)
        client.ns_index = "নির্ঘণ্ট"

        def fake_call(params, **kwargs):
            if params.get("list") == "prefixsearch":
                return {"query": {"prefixsearch": [
                    {"title": "নির্ঘণ্ট:Book A.pdf"},
                ]}}
            if params.get("list") == "search":
                return {"query": {"search": [
                    {"title": "নির্ঘণ্ট:Book A.pdf", "snippet": "duplicate"},
                    {"title": "নির্ঘণ্ট:Book B.pdf",
                     "snippet": "<span>Book</span> &amp; text"},
                ]}}
            return {}

        client._call = fake_call
        results = client.search_index_details("Book")
        self.assertEqual([item["title"] for item in results], [
            "নির্ঘণ্ট:Book A.pdf", "নির্ঘণ্ট:Book B.pdf",
        ])
        self.assertEqual(results[1]["snippet"], "Book & text")


if __name__ == "__main__":
    unittest.main()
