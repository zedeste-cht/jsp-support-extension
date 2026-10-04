package com.acme.core;

import org.apache.commons.lang3.StringUtils;

public class UserService {
    public String findName(int id) {
        return StringUtils.capitalize("user" + id);
    }
}
